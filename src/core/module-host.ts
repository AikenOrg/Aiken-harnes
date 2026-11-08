import type { ModuleContext, ModuleExports } from "../protocol/ctx.ts";
import type { ApprovalDecision, ApprovalRequest } from "../protocol/approval.ts";
import type { Capability, ModuleManifest, ModuleRole } from "../protocol/manifest.ts";
import type { HarnessError } from "../protocol/common.ts";
import { EXCLUSIVE_ROLES } from "../protocol/manifest.ts";
import type { ApprovalManager, ModuleSource } from "./approvals.ts";
import type { ContextFactoryOptions } from "./context.ts";
import { createModuleContext } from "./context.ts";

export type ModuleDefinition = {
  manifest: ModuleManifest;
  config?: Record<string, unknown>;
  source?: ModuleSource;
  codeHash?: string;
  builtin?: boolean;
  init?: ModuleExports["init"];
  dispose?: ModuleExports["dispose"];
  methods?: ModuleExports["methods"];
  /** 承認後にコードを import するための遅延ローダー。 */
  activate?: () => Promise<ModuleExports>;
};

export type ModuleHostOptions = Omit<ContextFactoryOptions, "callModule" | "log"> & {
  log: ContextFactoryOptions["log"];
  autoApprove?: boolean;
  approve?: (manifest: ModuleManifest) => boolean | Promise<boolean>;
  approvals?: ApprovalManager;
};

type LoadedModule = {
  definition: ModuleDefinition;
  context: ModuleContext;
};

export class ModuleHost {
  #definitions = new Map<string, ModuleDefinition>();
  #loaded: LoadedModule[] = [];
  #disabled = new Map<string, string>();
  #disabledRoles = new Set<ModuleRole>();
  #roleOwners = new Map<ModuleRole, string>();
  #options: ModuleHostOptions;

  constructor(options: ModuleHostOptions) {
    this.#options = options;
  }

  get loadedNames(): string[] {
    return this.#loaded.map((item) => item.definition.manifest.name);
  }

  get disabledNames(): string[] {
    return [...this.#disabled.keys()];
  }

  /** 実行中モジュールの死亡を通知し、そのジョブを failed にする。 */
  failModule(name: string, error: HarnessError): void {
    const definition = this.#definitions.get(name);
    if (!definition) return;
    this.#options.jobs.failModule(name, error);
    this.#options.bus.emit(
      "module.failed",
      { v: 1, module: name, error },
      { source: "core" },
    );
    this.#disable(name, error.message);
    if (definition.manifest.critical) throw new Error(error.message);
  }

  hasRole(role: ModuleRole): boolean {
    return this.#roleOwners.has(role);
  }

  roleOwner(role: ModuleRole): string | undefined {
    return this.#roleOwners.get(role);
  }

  async callRole<T = unknown>(role: ModuleRole, method: string, args?: unknown): Promise<T> {
    const owner = this.#roleOwners.get(role);
    if (!owner) throw new Error(`role not available: ${role}`);
    const item = this.#loaded.find((entry) => entry.definition.manifest.name === owner);
    if (!item) throw new Error(`role owner not loaded: ${role} (${owner})`);
    const fn = item.definition.methods?.[method];
    if (!fn) throw new Error(`role method not found: ${role}.${method}`);
    return (await fn(args)) as T;
  }

  async load(definitions: ModuleDefinition[]): Promise<void> {
    if (
      definitions.length > 0 &&
      !this.#options.autoApprove &&
      !this.#options.approve &&
      !this.#options.approvals
    ) {
      throw new Error("module approval is required (approvals, approve, or autoApprove)");
    }
    for (const definition of definitions) {
      const name = definition.manifest.name;
      if (this.#definitions.has(name)) throw new Error(`duplicate module name: ${name}`);
      if (definition.manifest.runner !== "inprocess") {
        throw new Error(`unsupported runner for ${name}: ${definition.manifest.runner}`);
      }
      this.#definitions.set(name, definition);
    }

    this.#checkRoles();
    this.#checkPermissions();

    const order = this.#resolveOrder();
    for (const name of order) {
      const definition = this.#definitions.get(name);
      if (!definition) continue;
      const disabledDependency = this.#disabledDependency(definition);
      if (disabledDependency) {
        this.#disable(name, `dependency disabled: ${disabledDependency}`);
        continue;
      }
      const approved = await this.#authorize(definition);
      if (!approved) {
        this.#disable(name, "permission not approved");
        if (definition.manifest.critical) throw new Error(`module approval denied: ${name}`);
        continue;
      }

      this.#grantPermissions(definition.manifest);
      let activated: ModuleExports | undefined;
      try {
        activated = definition.activate ? await definition.activate() : undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#options.bus.emit(
          "module.failed",
          { v: 1, module: name, error: { code: "module_import_failed", message } },
          { source: "core" },
        );
        if (definition.manifest.critical) throw error;
        this.#disable(name, message);
        continue;
      }
      const runtimeDefinition: ModuleDefinition = activated
        ? {
            ...definition,
            ...activated,
            manifest: definition.manifest,
            ...(definition.source !== undefined ? { source: definition.source } : {}),
            ...(definition.codeHash !== undefined ? { codeHash: definition.codeHash } : {}),
            ...(definition.builtin !== undefined ? { builtin: definition.builtin } : {}),
            ...(definition.config !== undefined ? { config: definition.config } : {}),
          }
        : definition;
      const init = runtimeDefinition.init;
      if (!init) {
        const message = `module ${name} does not export init()`;
        this.#options.bus.emit(
          "module.failed",
          { v: 1, module: name, error: { code: "invalid_module", message } },
          { source: "core" },
        );
        if (definition.manifest.critical) throw new Error(message);
        this.#disable(name, message);
        continue;
      }

      const context = createModuleContext(
        { manifest: definition.manifest, config: definition.config ?? {} },
        {
          ...this.#options,
          callModule: (caller, target, method, args) => this.call(caller, target, method, args),
        },
      );

      try {
        await init(context, definition.config ?? {});
        this.#loaded.push({ definition: runtimeDefinition, context });
        this.#options.bus.emit(
          "module.loaded",
          {
            v: 1,
            module: name,
            version: definition.manifest.version,
            roles: [...definition.manifest.roles],
            critical: definition.manifest.critical,
          },
          { source: "core" },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#options.bus.emit(
          "module.failed",
          { v: 1, module: name, error: { code: "module_init_failed", message } },
          { source: "core" },
        );
        if (definition.manifest.critical) throw error;
        this.#disable(name, message);
        if (definition.manifest.roles.includes("provider")) {
          for (const role of definition.manifest.roles) {
            if (this.#roleOwners.get(role) === name) this.#roleOwners.delete(role);
          }
        }
      }
    }

    if (!this.hasRole("provider")) {
      throw new Error("at least one provider module is required");
    }
  }

  async dispose(): Promise<void> {
    for (const item of [...this.#loaded].reverse()) {
      try {
        await item.definition.dispose?.();
      } catch (error) {
        this.#options.log.error(`dispose failed: ${item.definition.manifest.name}`, error);
      }
    }
    this.#loaded = [];
  }

  async call(caller: string, target: string, method: string, args?: unknown): Promise<unknown> {
    const item = this.#loaded.find((entry) => entry.definition.manifest.name === target);
    if (!item) throw new Error(`module not available: ${target}`);
    const fn = item.definition.methods?.[method];
    if (!fn) throw new Error(`method not found: ${target}.${method}`);
    this.#options.log.debug(`module.call ${caller} -> ${target}.${method}`);
    return fn(args);
  }

  async #authorize(definition: ModuleDefinition): Promise<boolean> {
    const manifest = definition.manifest;
    const permissions = this.#permissionStrings(manifest);
    if (manifest.builtin === true || definition.builtin === true) {
      if (this.#options.approvals) {
        const result = await this.#options.approvals.authorize({
          manifest,
          ...(definition.source !== undefined ? { source: definition.source } : {}),
          ...(definition.codeHash !== undefined ? { codeHash: definition.codeHash } : {}),
          requestApproval: this.#requestApproval,
        });
        return result.approved;
      }
      this.#options.bus.emit(
        "permission.granted",
        { v: 1, module: manifest.name, permissions, source: "builtin" },
        { source: "core" },
      );
      return true;
    }
    if (this.#options.autoApprove) {
      this.#options.bus.emit(
        "permission.granted",
        { v: 1, module: manifest.name, permissions, source: "autoApprove" },
        { source: "core" },
      );
      return true;
    }
    if (this.#options.approvals) {
      const result = await this.#options.approvals.authorize({
        manifest,
        ...(definition.source !== undefined ? { source: definition.source } : {}),
        ...(definition.codeHash !== undefined ? { codeHash: definition.codeHash } : {}),
        requestApproval: this.#requestApproval,
      });
      return result.approved;
    }
    if (this.#options.approve) return this.#options.approve(manifest);
    return false;
  }

  #requestApproval = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const owner = this.#roleOwners.get("ui");
    if (!owner) return { approved: false, reason: "ui role unavailable" };
    const item = this.#loaded.find((entry) => entry.definition.manifest.name === owner);
    const method = item?.definition.methods?.requestApproval;
    if (!method) return { approved: false, reason: "ui approval method unavailable" };
    return (await method(request)) as ApprovalDecision;
  };

  #permissionStrings(manifest: ModuleManifest): string[] {
    return (manifest.permissions ?? []).map((permission) => {
      const parts: string[] = [permission.cap];
      if (permission.paths) parts.push(`paths=${[...permission.paths].sort().join(",")}`);
      if (permission.hosts) parts.push(`hosts=${[...permission.hosts].sort().join(",")}`);
      if (permission.names) parts.push(`names=${[...permission.names].sort().join(",")}`);
      if (permission.mode) parts.push(`mode=${permission.mode}`);
      if (permission.allow) parts.push(`allow=${[...permission.allow].sort().join(",")}`);
      return parts.join(":");
    });
  }

  #checkRoles(): void {
    for (const definition of this.#definitions.values()) {
      for (const role of definition.manifest.roles) {
        if (EXCLUSIVE_ROLES.includes(role as (typeof EXCLUSIVE_ROLES)[number])) {
          const owner = this.#roleOwners.get(role);
          if (owner !== undefined && owner !== definition.manifest.name) {
            throw new Error(`exclusive role ${role} requested by ${owner} and ${definition.manifest.name}`);
          }
        }
        if (!this.#roleOwners.has(role)) this.#roleOwners.set(role, definition.manifest.name);
      }
    }
  }

  #checkPermissions(): void {
    for (const definition of this.#definitions.values()) {
      const name = definition.manifest.name;
      const caps = new Set(definition.manifest.permissions?.map((permission) => permission.cap) ?? []);
      const roles = new Set(definition.manifest.roles);
      if (caps.has("history.rewrite") && !roles.has("compactor")) {
        throw new Error(`${name}: history.rewrite requires compactor role`);
      }
      if (caps.has("history.restore") && !roles.has("history-store")) {
        throw new Error(`${name}: history.restore requires history-store role`);
      }
      if (caps.has("exec") && !roles.has("shell")) {
        throw new Error(`${name}: exec requires shell role`);
      }
      if (caps.has("secrets.read") && !roles.has("provider")) {
        throw new Error(`${name}: secrets.read requires provider role`);
      }
      if (caps.has("session.delete") && !roles.has("ui")) {
        throw new Error(`${name}: session.delete requires ui role`);
      }
    }
  }

  #grantPermissions(manifest: ModuleManifest): Capability[] {
    const capabilities = (manifest.permissions ?? []).map((permission) => permission.cap);
    this.#options.permissions.grant({
      module: manifest.name,
      capabilities,
      roles: manifest.roles,
    });
    return capabilities;
  }

  #resolveOrder(): string[] {
    const byName = new Set<string>(this.#definitions.keys());
    const byRole = new Map<ModuleRole, string>();
    for (const definition of this.#definitions.values()) {
      for (const role of definition.manifest.roles) {
        if (!byRole.has(role)) byRole.set(role, definition.manifest.name);
      }
    }

    const dependencies = new Map<string, string[]>();
    for (const [name, definition] of this.#definitions) {
      const deps: string[] = [];
      for (const requirement of definition.manifest.requires ?? []) {
        const resolved = byName.has(requirement) ? requirement : byRole.get(requirement as ModuleRole);
        if (!resolved) throw new Error(`${name}: unsatisfied requirement ${requirement}`);
        deps.push(resolved);
      }
      dependencies.set(name, deps);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`circular module dependency at ${name}`);
      visiting.add(name);
      for (const dep of dependencies.get(name) ?? []) visit(dep);
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const name of this.#definitions.keys()) visit(name);
    const rank = (name: string): number => {
      const definition = this.#definitions.get(name);
      if (!definition) return 3;
      if (definition.manifest.builtin === true || definition.builtin === true) return 0;
      if (definition.manifest.roles.includes("ui")) return 1;
      return 2;
    };
    return order
      .map((name, index) => ({ name, index }))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.index - b.index)
      .map((entry) => entry.name);
  }

  #disabledDependency(definition: ModuleDefinition): string | undefined {
    for (const requirement of definition.manifest.requires ?? []) {
      if (this.#disabled.has(requirement) || this.#disabledRoles.has(requirement as ModuleRole)) {
        return requirement;
      }
      const owner = this.#roleOwners.get(requirement as ModuleRole);
      if (owner && this.#disabled.has(owner)) return owner;
    }
    return undefined;
  }

  #disable(name: string, reason: string): void {
    if (this.#disabled.has(name)) return;
    this.#disabled.set(name, reason);
    const definition = this.#definitions.get(name);
    if (definition) {
      for (const tool of definition.manifest.tools ?? []) this.#options.tools.unregister(tool.name);
      for (const role of definition.manifest.roles) {
        this.#disabledRoles.add(role);
        if (this.#roleOwners.get(role) === name) this.#roleOwners.delete(role);
      }
    }
    this.#options.bus.emit(
      "module.disabled",
      { v: 1, module: name, reason },
      { source: "core" },
    );
  }
}
