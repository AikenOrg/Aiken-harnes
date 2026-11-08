import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ApprovalRequest } from "../../src/protocol/approval.ts";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { approveAllAllowed } from "../../src/core/approvals.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";

const tempDirs: string[] = [];

function config(): HarnessConfig {
  return { version: 1, modules: [], models: { default: "mock/echo" } };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "Aiken-harnes-approval-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function uiModule(
  requests: ApprovalRequest[],
  decide: (request: ApprovalRequest) => boolean = () => true,
): ModuleDefinition {
  return {
    manifest: {
      name: "ui-test",
      version: "0.1.0",
      roles: ["ui"],
      builtin: true,
      critical: false,
      runner: "inprocess",
    },
    init() {},
    methods: {
      requestApproval: async (value: unknown) => {
        const request = value as ApprovalRequest;
        requests.push(request);
        return { approved: decide(request) };
      },
    },
  };
}

async function testModule(
  parent: string,
  name: string,
  options: {
    code?: string;
    permissions?: Array<Record<string, unknown>>;
    critical?: boolean;
    builtin?: boolean;
    roles?: string[];
  } = {},
): Promise<ModuleDefinition> {
  return loadModuleDefinition(await makeModuleDir(parent, name, options), process.cwd());
}

async function makeModuleDir(
  parent: string,
  name: string,
  options: {
    code?: string;
    permissions?: Array<Record<string, unknown>>;
    critical?: boolean;
    builtin?: boolean;
    roles?: string[];
  } = {},
): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        roles: options.roles ?? [],
        critical: options.critical ?? false,
        runner: "inprocess",
        main: "index.ts",
        ...(options.builtin !== undefined ? { builtin: options.builtin } : {}),
        permissions: options.permissions ?? [],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(dir, "index.ts"), options.code ?? "export const init = () => {};\n", "utf8");
  return dir;
}

async function provider(): Promise<ModuleDefinition> {
  return loadModuleDefinition("./src/modules/provider-mock", process.cwd());
}

function harness(
  modules: ModuleDefinition[],
  approvalsPath: string,
  autoApprove = false,
  idsPrefix = "approval",
): Harness {
  return new Harness({
    config: config(),
    modules,
    approvalsPath,
    ...(autoApprove ? { autoApprove: true } : {}),
    ids: createSequentialIds(idsPrefix),
  });
}

describe("approvals", () => {
  test("allowApproveAll=false disables the development bypass", () => {
    expect(approveAllAllowed({})).toBe(true);
    expect(approveAllAllowed({ allowApproveAll: true })).toBe(true);
    expect(approveAllAllowed({ allowApproveAll: false })).toBe(false);
  });

  test("requests once, records, then starts without asking", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    const requests: ApprovalRequest[] = [];
    const module = await testModule(dir, "demo", {
      permissions: [{ cap: "history.read" }],
    });

    const h1 = harness([await provider(), module, uiModule(requests)], approvalsPath);
    await h1.start();
    expect(requests).toHaveLength(1);
    expect(existsSync(approvalsPath)).toBe(true);
    const saved = JSON.parse(await readFile(approvalsPath, "utf8")) as {
      v: number;
      modules: Record<string, { codeHash: string; permissionsHash: string }>;
    };
    expect(saved.v).toBe(1);
    expect(saved.modules.demo?.codeHash).toMatch(/^[a-f0-9]{64}$/);
    await h1.stop();

    const h2 = harness([await provider(), await testModule(dir, "demo", { permissions: [{ cap: "history.read" }] }), uiModule(requests)], approvalsPath, false, "approval2");
    await h2.start();
    expect(requests).toHaveLength(1);
    await h2.stop();
  });

  test("re-approves code changes but ignores CRLF changes; diff on permission add and auto-update on reduce", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    const requests: ApprovalRequest[] = [];
    const base = { permissions: [{ cap: "history.read" }] };
    await makeModuleDir(dir, "demo", { ...base, code: "export const init = () => {};\n" });

    const h1 = harness([await provider(), await loadModuleDefinition(join(dir, "demo"), process.cwd()), uiModule(requests)], approvalsPath);
    await h1.start();
    await h1.stop();

    // code change
    await writeFile(join(dir, "demo", "index.ts"), "// changed\nexport const init = () => {};\n", "utf8");
    const h2 = harness([await provider(), await loadModuleDefinition(join(dir, "demo"), process.cwd()), uiModule(requests)], approvalsPath);
    await h2.start();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.changes).toContain("code changed");
    await h2.stop();

    // CRLF only
    await writeFile(join(dir, "demo", "index.ts"), "// changed\r\nexport const init = () => {};\r\n", "utf8");
    const h3 = harness([await provider(), await loadModuleDefinition(join(dir, "demo"), process.cwd()), uiModule(requests)], approvalsPath);
    await h3.start();
    expect(requests).toHaveLength(2);
    await h3.stop();

    // permission add
    const manifestPath = join(dir, "demo", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.permissions = [{ cap: "history.read" }, { cap: "net", hosts: ["example.com"] }];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const h4 = harness([await provider(), await loadModuleDefinition(join(dir, "demo"), process.cwd()), uiModule(requests)], approvalsPath);
    await h4.start();
    expect(requests).toHaveLength(3);
    expect(requests[2]?.changes.some((change) => change.startsWith("+ net"))).toBe(true);
    expect(requests[2]?.warnings).toContain("dangerous combination: history.read + net");
    await h4.stop();

    // permission reduce: no request
    manifest.permissions = [{ cap: "history.read" }];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const h5 = harness([await provider(), await loadModuleDefinition(join(dir, "demo"), process.cwd()), uiModule(requests)], approvalsPath);
    await h5.start();
    expect(requests).toHaveLength(3);
    await h5.stop();
  });

  test("denied critical module aborts; denied non-critical module is disabled", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    const requests: ApprovalRequest[] = [];
    const deny = () => false;

    const critical = await testModule(dir, "critical-demo", { critical: true });
    const h1 = harness([await provider(), critical, uiModule(requests, deny)], approvalsPath, false, "critical");
    await expect(h1.start()).rejects.toThrow();

    const nonCritical = await testModule(dir, "noncritical-demo", { critical: false });
    const h2 = harness([await provider(), nonCritical, uiModule(requests, deny)], approvalsPath, false, "noncritical");
    const events: EventEnvelope[] = [];
    h2.on("*", (event) => events.push(event));
    await h2.start();
    expect(h2.modules.loadedNames).not.toContain("noncritical-demo");
    expect(events.some((event) => event.type === "module.disabled")).toBe(true);
    await h2.stop();
  });

  test("warns about heavy permissions", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    const requests: ApprovalRequest[] = [];
    const module = await testModule(dir, "compactor-demo", {
      roles: ["compactor"],
      permissions: [{ cap: "history.rewrite" }],
    });
    const h = harness([await provider(), module, uiModule(requests)], approvalsPath, false, "heavy");
    await h.start();
    expect(requests[0]?.warnings).toContain("heavy permission: history.rewrite");
    await h.stop();
  });

  test("corrupt approvals file is quarantined to .bak and treated as empty", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    await writeFile(approvalsPath, "{not-json", "utf8");
    const requests: ApprovalRequest[] = [];
    const module = await testModule(dir, "demo");
    const h = harness([await provider(), module, uiModule(requests)], approvalsPath);
    await h.start();
    expect(requests).toHaveLength(1);
    expect(existsSync(`${approvalsPath}.bak`)).toBe(true);
    await h.stop();
  });

  test("approve-all bypasses approval and does not write approvals", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    const module = await testModule(dir, "demo");
    const h = harness([await provider(), module], approvalsPath, true, "approveall");
    await h.start();
    expect(existsSync(approvalsPath)).toBe(false);
    await h.stop();
  });

  test("does not import module code before approval", async () => {
    const dir = await tempDir();
    const approvalsPath = join(dir, "approvals.json");
    const moduleDir = await makeModuleDir(dir, "side-effect", {
      code: "(globalThis as any).__approvalSideEffect = true;\nexport const init = () => {};\n",
    });
    const module = await loadModuleDefinition(moduleDir, process.cwd());
    expect((globalThis as { __approvalSideEffect?: boolean }).__approvalSideEffect).toBeUndefined();

    const requests: ApprovalRequest[] = [];
    const h = harness([await provider(), module, uiModule(requests, () => false)], approvalsPath);
    await h.start();
    expect((globalThis as { __approvalSideEffect?: boolean }).__approvalSideEffect).toBeUndefined();
    await h.stop();
  });
});
