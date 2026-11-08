import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Capability, ModuleManifest, PermissionRequest } from "../protocol/manifest.ts";
import type { ModelInfo } from "../protocol/provider.ts";
import type {
  AgentApi,
  BusApi,
  EnvApi,
  FsApi,
  HistoryApi,
  HookApi,
  HookType,
  JobsApi,
  LogApi,
  ModuleContext,
  ModulesApi,
  NetApi,
  PromptApi,
  ProviderApi,
  SecretsApi,
  SessionApi,
  ToolApi,
} from "../protocol/ctx.ts";
import type { ToolDefinition } from "../protocol/tools.ts";
import type { Message, NewMessage } from "../protocol/messages.ts";
import type { PromptSegmentInput } from "../protocol/prompt.ts";
import type { Provider } from "../protocol/provider.ts";
import { eventMatches, type EventBus } from "./bus.ts";
import type { HistoryManager } from "./history.ts";
import type { HookRunner } from "./hooks.ts";
import type { JobManager } from "./jobs.ts";
import type { Logger } from "./log.ts";
import { PermissionError, type PermissionBroker } from "./permissions.ts";
import type { PromptAssembler } from "./prompt.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { SessionManager } from "./sessions.ts";
import type { ToolRegistry } from "./tools.ts";

export class SecretsBroker {
  #config: Record<string, { env: string }>;
  #active = new Map<string, number>();

  constructor(config?: Record<string, { env: string }>) {
    this.#config = config ?? {};
  }

  begin(module: string): void {
    this.#active.set(module, (this.#active.get(module) ?? 0) + 1);
  }

  end(module: string): void {
    const count = this.#active.get(module) ?? 0;
    if (count <= 1) this.#active.delete(module);
    else this.#active.set(module, count - 1);
  }

  get(module: string, name: string): string {
    if ((this.#active.get(module) ?? 0) <= 0) {
      throw new Error(`secrets are only available during provider.stream(): ${name}`);
    }
    const entry = this.#config[name];
    if (!entry) throw new Error(`secret not configured: ${name}`);
    const value = process.env[entry.env];
    if (value === undefined) throw new Error(`environment variable not set: ${entry.env}`);
    return value;
  }
}

export type ModuleRuntime = {
  manifest: ModuleManifest;
  config: Record<string, unknown>;
};

export type ContextFactoryOptions = {
  bus: EventBus;
  tools: ToolRegistry;
  jobs: JobManager;
  history: HistoryManager;
  prompt: PromptAssembler;
  sessions: SessionManager;
  hooks: HookRunner;
  providers: ProviderRegistry;
  permissions: PermissionBroker;
  secrets: SecretsBroker;
  log: Logger;
  baseDir: string;
  callModule?: (caller: string, target: string, method: string, args?: unknown) => Promise<unknown>;
};

function permissionOf(manifest: ModuleManifest, cap: Capability): PermissionRequest | undefined {
  return manifest.permissions?.find((permission) => permission.cap === cap);
}

function assertInside(baseDir: string, allowed: readonly string[], path: string): string {
  const resolvedBase = resolve(baseDir);
  const target = isAbsolute(path) ? resolve(path) : resolve(resolvedBase, path);
  const allowedRoots = allowed.map((entry) => {
    const root = isAbsolute(entry) ? resolve(entry) : resolve(resolvedBase, entry);
    return root;
  });
  const inside = allowedRoots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!inside) throw new Error(`path outside declared roots: ${path}`);
  return target;
}

function isInsideRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

async function realRoots(baseDir: string, allowed: readonly string[]): Promise<string[]> {
  const resolvedBase = resolve(baseDir);
  return Promise.all(
    allowed.map(async (entry) => {
      const root = isAbsolute(entry) ? resolve(entry) : resolve(resolvedBase, entry);
      try {
        return await realpath(root);
      } catch {
        return root;
      }
    }),
  );
}

async function assertRealInside(
  baseDir: string,
  allowed: readonly string[],
  path: string,
): Promise<string> {
  const target = assertInside(baseDir, allowed, path);
  const roots = await realRoots(baseDir, allowed);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    real = target;
  }
  if (!isInsideRoots(real, roots)) throw new Error(`path escapes declared roots: ${path}`);
  return real;
}

async function assertWriteInside(
  baseDir: string,
  allowed: readonly string[],
  path: string,
): Promise<string> {
  const target = assertInside(baseDir, allowed, path);
  const roots = await realRoots(baseDir, allowed);
  const parent = dirname(target);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch {
    realParent = parent;
  }
  if (!isInsideRoots(realParent, roots)) throw new Error(`path escapes declared roots: ${path}`);
  return resolve(realParent, basename(target));
}

function declaredSubscription(manifest: ModuleManifest, requested: string): boolean {
  return manifest.subscribes?.some((declared) => {
    if (declared === requested || declared === "*") return true;
    if (declared.endsWith(".*") && requested.startsWith(declared.slice(0, -1))) return true;
    return false;
  }) ?? false;
}

function moduleEventAllowed(module: string, type: string): boolean {
  return type.startsWith(`module.${module}.`);
}

/** モジュールに渡す唯一の窓口を作る。 */
export function createModuleContext(
  runtime: ModuleRuntime,
  options: ContextFactoryOptions,
): ModuleContext {
  const { manifest } = runtime;
  const moduleName = manifest.name;
  const requireCap = (cap: Capability): void => options.permissions.require(moduleName, cap);
  const requireRole = (role: ModuleManifest["roles"][number]): void => {
    options.permissions.requireRole(moduleName, role);
  };

  const bus: BusApi = {
    on: (type, handler) => {
      if (!declaredSubscription(manifest, type)) {
        throw new PermissionError(moduleName, `subscribe:${type}`);
      }
      return options.bus.on(type, handler);
    },
    once: (type, handler) => {
      if (!declaredSubscription(manifest, type)) {
        throw new PermissionError(moduleName, `subscribe:${type}`);
      }
      return options.bus.once(type, handler);
    },
    emit: (type, payload, sessionId) => {
      if (!moduleEventAllowed(moduleName, type)) {
        throw new PermissionError(moduleName, `emit:${type}`);
      }
      options.bus.emit(type, payload, sessionId === undefined
        ? { source: moduleName }
        : { source: moduleName, sessionId });
    },
  };

  const tools: ToolApi = {
    register: (definition: ToolDefinition) => {
      requireCap("tool.register");
      const declared = manifest.tools?.find((tool) => tool.name === definition.name);
      if (!declared) throw new Error(`tool not declared in manifest: ${definition.name}`);
      if (declared.mode !== definition.mode) {
        throw new Error(`tool ${definition.name} mode mismatch: ${declared.mode} != ${definition.mode}`);
      }
      options.tools.register(definition, moduleName);
    },
    unregister: (name) => {
      requireCap("tool.register");
      options.tools.unregister(name);
    },
  };

  const providers: ProviderApi = {
    register: (provider: Provider) => {
      requireRole("provider");
      options.providers.register(provider, moduleName);
    },
  };

  const jobs: JobsApi = {
    done: (jobId, input) => options.jobs.done(jobId, moduleName, input),
    fail: (jobId, input) => options.jobs.fail(jobId, moduleName, input),
  };

  const history: HistoryApi = {
    read: (sessionId, readOptions) => {
      requireCap("history.read");
      return Promise.resolve(options.history.read(sessionId, readOptions));
    },
    get: (sessionId, messageId) => {
      requireCap("history.read");
      return Promise.resolve(options.history.get(sessionId, messageId));
    },
    append: (sessionId, message: NewMessage) => {
      requireCap("history.append");
      return Promise.resolve(options.history.append(sessionId, message));
    },
    appendBatch: (sessionId, messages: NewMessage[]) => {
      requireCap("history.append");
      return Promise.resolve(options.history.appendBatch(sessionId, messages));
    },
    restore: (sessionId, messages: Message[]) => {
      requireCap("history.restore");
      requireRole("history-store");
      options.history.restore(sessionId, messages);
      return Promise.resolve();
    },
    rewrite: (sessionId, messages: Message[], reason: string) => {
      requireCap("history.rewrite");
      requireRole("compactor");
      options.history.rewrite(sessionId, messages, reason);
      return Promise.resolve();
    },
    count: (sessionId) => {
      requireCap("history.read");
      return Promise.resolve(options.history.count(sessionId));
    },
  };

  const prompt: PromptApi = {
    contribute: (segment: PromptSegmentInput) => {
      requireCap("prompt.contribute");
      options.prompt.contribute(segment, moduleName);
    },
    remove: (id) => {
      requireCap("prompt.contribute");
      options.prompt.remove(id, moduleName);
    },
    list: () => {
      requireCap("prompt.contribute");
      return options.prompt.list(moduleName);
    },
  };

  const sessions: SessionApi = {
    get: (sessionId) => options.sessions.get(sessionId),
    create: (createOptions) => {
      requireCap("session.manage");
      return Promise.resolve(options.sessions.create(createOptions));
    },
    fork: () => {
      requireCap("session.manage");
      throw new Error("session.fork is not implemented in M1");
    },
    listRestorable: () => {
      requireCap("session.manage");
      throw new Error("session.listRestorable requires a session-store (not implemented in M1)");
    },
    restore: () => {
      requireCap("session.manage");
      throw new Error("session.restore requires a session-store (not implemented in M1)");
    },
    close: (sessionId) => {
      requireCap("session.manage");
      const closed = options.sessions.close(sessionId);
      for (const session of closed) options.jobs.cancelBySession(session.id, "system", "session closed");
      return Promise.resolve();
    },
    delete: (sessionId) => {
      requireCap("session.delete");
      options.sessions.delete(sessionId);
      options.history.deleteSession(sessionId);
      return options.jobs.deleteSession(sessionId);
    },
    setModel: (sessionId, model) => {
      requireCap("session.manage");
      options.sessions.setModel(sessionId, model);
    },
  };

  const agent: AgentApi = {
    spawn: () => {
      requireCap("agent.spawn");
      requireCap("prompt.contribute");
      throw new Error("agent.spawn is not implemented in M1");
    },
    message: () => {
      requireCap("agent.message");
      throw new Error("agent.message is not implemented in M1");
    },
    cancel: () => {
      requireCap("agent.spawn");
      throw new Error("agent.cancel is not implemented in M1");
    },
    close: () => {
      requireCap("agent.spawn");
      throw new Error("agent.close is not implemented in M1");
    },
  };

  const hooks: HookApi = {
    register: (type: HookType, handler) => {
      if (type === "prompt.assemble") requireCap("prompt.contribute");
      else if (type === "tool.before") requireCap("tool.intercept");
      else requireRole("compactor");
      return options.hooks.register(type, moduleName, handler as (input: never) => unknown);
    },
  };

  const fs: FsApi = {
    baseDir: options.baseDir,
    read: async (path) => {
      requireCap("fs.read");
      const allowed = permissionOf(manifest, "fs.read")?.paths ?? [];
      return new Uint8Array(await readFile(await assertRealInside(options.baseDir, allowed, path)));
    },
    write: async (path, data) => {
      requireCap("fs.write");
      const allowed = permissionOf(manifest, "fs.write")?.paths ?? [];
      await writeFile(await assertWriteInside(options.baseDir, allowed, path), data);
    },
    list: async (path) => {
      requireCap("fs.read");
      const allowed = permissionOf(manifest, "fs.read")?.paths ?? [];
      return readdir(await assertRealInside(options.baseDir, allowed, path));
    },
    stat: async (path) => {
      requireCap("fs.read");
      const allowed = permissionOf(manifest, "fs.read")?.paths ?? [];
      const info = await stat(await assertRealInside(options.baseDir, allowed, path));
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
    realpath: async (path) => {
      requireCap("fs.read");
      const allowed = permissionOf(manifest, "fs.read")?.paths ?? [];
      return assertRealInside(options.baseDir, allowed, path);
    },
  };

  const net: NetApi = {
    fetch: async (input, init) => {
      requireCap("net");
      const allowed = permissionOf(manifest, "net")?.hosts ?? [];
      const url = new URL(input);
      const hostAllowed = allowed.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      );
      if (!hostAllowed) throw new Error(`host not allowed: ${url.hostname}`);
      return fetch(input, init);
    },
  };

  const env: EnvApi = {
    get: (name) => {
      requireCap("env");
      const allowed = permissionOf(manifest, "env")?.names ?? [];
      if (!allowed.includes(name)) throw new Error(`env not allowed: ${name}`);
      return process.env[name];
    },
  };

  const secrets: SecretsApi = {
    get: (name) => {
      requireCap("secrets.read");
      requireRole("provider");
      return options.secrets.get(moduleName, name);
    },
  };

  const modules: ModulesApi = {
    call: async <T = unknown>(target: string, method: string, args?: unknown): Promise<T> => {
      if (!(manifest.talksTo ?? []).includes(target)) {
        throw new PermissionError(moduleName, `module.talk:${target}`);
      }
      requireCap(`module.talk:${target}` as Capability);
      if (!options.callModule) throw new Error("module calls are not available");
      return (await options.callModule(moduleName, target, method, args)) as T;
    },
  };

  const log: LogApi = {
    debug: (message, meta) => options.log.debug(`[${moduleName}] ${message}`, meta),
    info: (message, meta) => options.log.info(`[${moduleName}] ${message}`, meta),
    warn: (message, meta) => options.log.warn(`[${moduleName}] ${message}`, meta),
    error: (message, meta) => options.log.error(`[${moduleName}] ${message}`, meta),
  };

  return {
    name: moduleName,
    bus,
    tools,
    providers,
    jobs,
    history,
    prompt,
    session: sessions,
    agent,
    hooks,
    fs,
    net,
    env,
    secrets,
    modules,
    log,
  };
}

/** 型補助: 利用側で Provider の models() を満たすか検査する。 */
export function assertModelInfo(model: ModelInfo): void {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error(`invalid contextWindow for ${model.id}`);
  }
}

export { eventMatches };
