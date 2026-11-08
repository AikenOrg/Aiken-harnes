import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "../protocol/approval.ts";
import type { EventBus } from "./bus.ts";
import type { Logger } from "./log.ts";
import type { ModuleManifest } from "../protocol/manifest.ts";

export type ModuleSource = {
  rootDir: string;
  entryPath: string;
  manifestPath: string;
  isDirectory: boolean;
};

export function approveAllAllowed(config: { allowApproveAll?: boolean | undefined }): boolean {
  return config.allowApproveAll !== false;
}

export type ApprovalRecord = {
  codeHash: string;
  /** manifest を除くコードだけのハッシュ。権限削減の自動更新判定に使う。 */
  codeOnlyHash?: string;
  permissionsHash: string;
  permissions: string[];
  approvedAt: number;
};

type ApprovalsFile = {
  v: 1;
  modules: Record<string, ApprovalRecord>;
};

const HEAVY_CAPS = new Set([
  "exec",
  "secrets.read",
  "tool.intercept",
  "history.rewrite",
  "history.restore",
  "session.delete",
]);

const EMPTY_FILE: ApprovalsFile = { v: 1, modules: {} };

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) output[key] = canonicalize(input[key]);
    return output;
  }
  return value;
}

function permissionsHash(manifest: ModuleManifest): string {
  return sha256(
    JSON.stringify(
      canonicalize({
        roles: manifest.roles,
        talksTo: manifest.talksTo ?? [],
        permissions: manifest.permissions ?? [],
        tools: manifest.tools ?? [],
        main: manifest.main ?? null,
        version: manifest.version,
      }),
    ),
  );
}

function permissionKey(permission: NonNullable<ModuleManifest["permissions"]>[number]): string {
  const parts: string[] = [permission.cap];
  if (permission.paths) parts.push(`paths=${[...permission.paths].sort().join(",")}`);
  if (permission.hosts) parts.push(`hosts=${[...permission.hosts].sort().join(",")}`);
  if (permission.names) parts.push(`names=${[...permission.names].sort().join(",")}`);
  if (permission.mode) parts.push(`mode=${permission.mode}`);
  if (permission.allow) parts.push(`allow=${[...permission.allow].sort().join(",")}`);
  return parts.join(":");
}

function permissionKeys(manifest: ModuleManifest): string[] {
  return [...new Set((manifest.permissions ?? []).map(permissionKey))].sort();
}

export function buildWarnings(manifest: ModuleManifest): string[] {
  const caps = new Set((manifest.permissions ?? []).map((permission) => permission.cap));
  const warnings: string[] = [];
  for (const cap of caps) {
    if (HEAVY_CAPS.has(cap)) warnings.push(`heavy permission: ${cap}`);
  }
  if (caps.has("history.read") && caps.has("net")) {
    warnings.push("dangerous combination: history.read + net");
  }
  if (caps.has("fs.read") && caps.has("net")) {
    warnings.push("dangerous combination: fs.read + net");
  }
  return warnings;
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  await visit(root);
  return out;
}

/** コード実行前に、モジュールのソース・manifest から SHA-256 を作る。 */
export async function hashModuleCode(
  source: ModuleSource,
  options: { excludeManifest?: boolean } = {},
): Promise<string> {
  let paths: string[];
  if (source.isDirectory) {
    paths = await walkFiles(source.rootDir);
  } else {
    paths = [source.entryPath, source.manifestPath];
  }
  if (options.excludeManifest) {
    paths = paths.filter((path) => path !== source.manifestPath);
  }
  const normalized = paths.map((path) => relative(source.rootDir, path).split(/[\\/]+/).join("/"));
  const ordered = paths
    .map((path, index) => ({ path, name: normalized[index]! }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const hash = createHash("sha256");
  for (const item of ordered) {
    const content = normalizeText(await readFile(item.path, "utf8"));
    hash.update(`${item.name}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateFile(value: unknown): value is ApprovalsFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<ApprovalsFile>;
  if (file.v !== 1 || typeof file.modules !== "object" || file.modules === null) return false;
  for (const record of Object.values(file.modules)) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.codeHash !== "string" ||
      typeof record.permissionsHash !== "string" ||
      !Array.isArray(record.permissions) ||
      typeof record.approvedAt !== "number"
    ) {
      return false;
    }
  }
  return true;
}

/** approvals.json の読み書き。壊れたファイルは .bak に退避して fail closed。 */
export class ApprovalStore {
  #path: string;
  #logger: Logger;

  constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  get path(): string {
    return this.#path;
  }

  async get(moduleName: string): Promise<ApprovalRecord | undefined> {
    const file = await this.#read();
    return file.modules[moduleName];
  }

  async upsert(moduleName: string, record: ApprovalRecord): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    // 書き込み直前に読み直す (複数プロセス起動時の取りこぼしを減らす)。
    const file = await this.#read();
    file.modules[moduleName] = record;
    const temporary = `${this.#path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #read(): Promise<ApprovalsFile> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_FILE);
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!validateFile(parsed)) throw new Error("invalid approvals file");
      return parsed;
    } catch (error) {
      await this.#quarantine();
      this.#logger.warn("approvals.json is invalid; treating as no approvals", error);
      return structuredClone(EMPTY_FILE);
    }
  }

  async #quarantine(): Promise<void> {
    const backup = `${this.#path}.bak`;
    try {
      await rm(backup, { force: true });
      await rename(this.#path, backup);
      await writeFile(this.#path, `${JSON.stringify(EMPTY_FILE, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.#logger.error("failed to quarantine approvals.json", error);
    }
  }
}

export type ApprovalAuthorization = {
  approved: boolean;
  reason?: string;
  source?: "stored" | "updated" | "user" | "denied";
};

/** 承認記録とハッシュを照合し、必要なら UI に承認を求める。 */
export class ApprovalManager {
  #store: ApprovalStore;
  #bus: EventBus;
  #logger: Logger;

  constructor(store: ApprovalStore, bus: EventBus, logger: Logger) {
    this.#store = store;
    this.#bus = bus;
    this.#logger = logger;
  }

  async authorize(input: {
    manifest: ModuleManifest;
    source?: ModuleSource;
    codeHash?: string;
    requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  }): Promise<ApprovalAuthorization> {
    const { manifest } = input;
    const permissions = permissionKeys(manifest);
    if (manifest.builtin === true) {
      this.#emitGranted(manifest, permissions, "builtin");
      const heavy = (manifest.permissions ?? []).filter((permission) => HEAVY_CAPS.has(permission.cap));
      if (heavy.length > 0) {
        this.#logger.warn(`builtin module has privileged permissions: ${manifest.name}`, heavy.map((p) => p.cap));
      }
      return { approved: true, source: "stored" };
    }
    if (!input.source || !input.codeHash) {
      this.#emitDenied(manifest, "module source/hash unavailable");
      return { approved: false, reason: "module source/hash unavailable" };
    }

    const currentHash = permissionsHash(manifest);
    const codeOnly = await hashModuleCode(input.source, { excludeManifest: true });
    const structural = sha256(
      JSON.stringify(
        canonicalize({
          tools: manifest.tools ?? [],
          main: manifest.main ?? null,
          version: manifest.version,
        }),
      ),
    );
    const currentCodeOnlyHash = sha256(`${codeOnly}:${structural}`);
    const record = await this.#store.get(manifest.name);
    if (
      record &&
      record.codeHash === input.codeHash &&
      record.permissionsHash === currentHash
    ) {
      this.#emitGranted(manifest, permissions, "stored");
      return { approved: true, source: "stored" };
    }

    const previousPermissions = new Set(record?.permissions ?? []);
    const newPermissions = new Set(permissions);
    const added = permissions.filter((permission) => !previousPermissions.has(permission));
    const removed = [...previousPermissions].filter((permission) => !newPermissions.has(permission));
    const codeChanged =
      record !== undefined &&
      (record.codeOnlyHash === undefined
        ? record.codeHash !== input.codeHash
        : record.codeOnlyHash !== currentCodeOnlyHash);
    const permissionsReduced =
      record !== undefined &&
      !codeChanged &&
      added.length === 0 &&
      removed.length > 0 &&
      record.permissionsHash !== currentHash;

    if (permissionsReduced) {
      await this.#store.upsert(manifest.name, {
        codeHash: input.codeHash,
        codeOnlyHash: currentCodeOnlyHash,
        permissionsHash: currentHash,
        permissions,
        approvedAt: Date.now(),
      });
      this.#emitGranted(manifest, permissions, "updated");
      return { approved: true, source: "updated" };
    }

    const changes: string[] = [];
    if (!record) changes.push("new module");
    if (codeChanged) changes.push("code changed");
    for (const permission of added) changes.push(`+ ${permission}`);
    for (const permission of removed) changes.push(`- ${permission}`);
    if (record && record.permissionsHash !== currentHash && added.length === 0 && removed.length === 0) {
      changes.push("manifest permissions/roles/talksTo changed");
    }

    const request: ApprovalRequest = {
      module: manifest.name,
      version: manifest.version,
      roles: [...manifest.roles],
      permissions,
      changes,
      warnings: buildWarnings(manifest),
      ...(record
        ? {
            previous: {
              approvedAt: record.approvedAt,
              codeHash: record.codeHash,
              permissionsHash: record.permissionsHash,
            },
          }
        : {}),
    };

    this.#bus.emit(
      "permission.requested",
      {
        v: 1,
        module: manifest.name,
        permissions,
        warnings: request.warnings,
        changes,
        codeHash: input.codeHash,
        permissionsHash: currentHash,
      },
      { source: "core" },
    );

    let decision: ApprovalDecision;
    try {
      decision = await input.requestApproval(request);
    } catch (error) {
      this.#logger.warn(`approval request failed for ${manifest.name}`, error);
      decision = { approved: false, reason: "approval request failed" };
    }
    if (!decision.approved) {
      this.#emitDenied(manifest, decision.reason ?? "denied by user");
      return { approved: false, reason: decision.reason ?? "denied by user" };
    }

    await this.#store.upsert(manifest.name, {
      codeHash: input.codeHash,
      codeOnlyHash: currentCodeOnlyHash,
      permissionsHash: currentHash,
      permissions,
      approvedAt: Date.now(),
    });
    this.#emitGranted(manifest, permissions, "user");
    return { approved: true, source: "user" };
  }

  #emitGranted(manifest: ModuleManifest, permissions: string[], source: string): void {
    this.#bus.emit(
      "permission.granted",
      { v: 1, module: manifest.name, permissions, source },
      { source: "core" },
    );
  }

  #emitDenied(manifest: ModuleManifest, reason: string): void {
    this.#bus.emit(
      "permission.denied",
      {
        v: 1,
        module: manifest.name,
        cap: "module",
        error: { code: "denied", message: reason },
      },
      { source: "core" },
    );
  }
}
