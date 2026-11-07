import type { Capability, ModuleRole } from "../protocol/manifest.ts";

export class PermissionError extends Error {
  readonly code = "permission_denied";
  readonly module: string;
  readonly cap: string;

  constructor(module: string, cap: string, message?: string) {
    super(message ?? `${module} lacks capability ${cap}`);
    this.name = "PermissionError";
    this.module = module;
    this.cap = cap;
  }
}

export type Grant = {
  module: string;
  capabilities: readonly Capability[];
  roles: readonly ModuleRole[];
};

export class PermissionBroker {
  #grants = new Map<string, Grant>();

  grant(grant: Grant): void {
    this.#grants.set(grant.module, grant);
  }

  rolesOf(module: string): readonly ModuleRole[] {
    return this.#grants.get(module)?.roles ?? [];
  }

  has(module: string, cap: Capability): boolean {
    return this.#grants.get(module)?.capabilities.includes(cap) ?? false;
  }

  require(module: string, cap: Capability): void {
    if (!this.has(module, cap)) throw new PermissionError(module, cap);
  }

  requireRole(module: string, role: ModuleRole): void {
    if (!this.rolesOf(module).includes(role)) {
      throw new PermissionError(module, `role:${role}`);
    }
  }

  capabilitiesOf(module: string): readonly Capability[] {
    return this.#grants.get(module)?.capabilities ?? [];
  }
}
