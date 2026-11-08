import type { ModuleContext, ModuleExports } from "../protocol/ctx.ts";
import type { Capability, ModuleManifest, ModuleRole } from "../protocol/manifest.ts";
import type { HarnessError } from "../protocol/common.ts";
import { EXCLUSIVE_ROLES } from "../protocol/manifest.ts";
import type { ContextFactoryOptions } from "./context.ts";
import { createModuleContext } from "./context.ts";

export type ModuleDefinition = ModuleExports & {
  manifest: ModuleManifest;
  config?: Record<string, unknown>;
};

export type ModuleHostOptions = Omit<ContextFactoryOptions, "callModule" | "log"> & {
  log: ContextFactoryOptions["log"];
  autoApprove?: boolean;
  approve?: (manifest: ModuleManifest) => boolean | Promise<boolean>;
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
    if (definitions.length > 0 && !this.#options.autoApprove && !this.#options.approve) {
      throw new Error("module approval is required (pass an approve callback or autoApprove)");
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
      if (!(await this.#approve(definition.manifest))) {
        this.#disable(name, "permission not approved");
        continue;
      }

      const permissions = this.#grantPermissions(definition.manifest);
      const runtime = {
        manifest: definition.manifest,
        config: definition.config ?? {},
      };
      const context = createModuleContext(runtime, {
        ...this.#options,
        callModule: (caller, target, method, args) => this.call(caller, target, method, args),
      });

      try {
        await definition.init(context, definition.config ?? {});
        this.#loaded.push({ definition, context });
        void permissions;
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

  async #approve(manifest: ModuleManifest): Promise<boolean> {
    if (this.#options.autoApprove) return true;
    if (!this.#options.approve) return false;
    return this.#options.approve(manifest);
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
    return order;
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
