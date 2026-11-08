import { z } from "zod";
import { CORE_VERSION } from "../protocol/version.ts";
import { configSchema, type HarnessConfig } from "../protocol/config.ts";
import type { ModuleManifest } from "../protocol/manifest.ts";
import type { ModelInfo } from "../protocol/provider.ts";
import type { EventEnvelope } from "../protocol/events.ts";
import type { Job, JobStatus } from "../protocol/jobs.ts";
import type { Message } from "../protocol/messages.ts";
import type { ToolCallBlock } from "../protocol/messages.ts";
import type { Session } from "../protocol/session.ts";
import type { ToolDefinition } from "../protocol/tools.ts";
import { EventBus } from "./bus.ts";
import { HistoryManager } from "./history.ts";
import { HookRunner } from "./hooks.ts";
import { createIdGenerator, type IdGenerator } from "./ids.ts";
import { JobManager, MemoryResultStore, type ResultStore } from "./jobs.ts";
import { Logger } from "./log.ts";
import { ApprovalManager, ApprovalStore } from "./approvals.ts";
import { approvalsFile } from "../shared/paths.ts";
import { ModuleHost, type ModuleDefinition } from "./module-host.ts";
import { PermissionBroker } from "./permissions.ts";
import { PromptAssembler } from "./prompt.ts";
import { ProviderRegistry } from "./providers.ts";
import { RoleResultStore } from "./role-result-store.ts";
import { SecretsBroker } from "./context.ts";
import { SessionManager } from "./sessions.ts";
import { ToolRegistry } from "./tools.ts";
import { TurnLoop } from "./turn-loop.ts";

export type HarnessOptions = {
  config: HarnessConfig;
  modules?: ModuleDefinition[];
  autoApprove?: boolean;
  approve?: (manifest: ModuleManifest) => boolean | Promise<boolean>;
  ids?: IdGenerator;
  bootId?: string;
  resultStore?: ResultStore;
  logger?: Logger;
  now?: () => number;
  maxSteps?: number;
  overflowRatio?: number;
  maxNotificationChars?: number;
  maxConcurrentPerSession?: number;
  baseDir?: string;
  approvalsPath?: string;
};

type QueuedMessage = {
  text: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** 復元時に、結果の欠けた tool_call へ interrupted の tool_result を補う。 */

function repairDanglingToolCalls(messages: Message[]): { messages: Message[]; repaired: number } {
  const resultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_result") resultIds.add(block.toolCallId);
    }
  }
  const out: Message[] = [];
  let repaired = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    out.push(message);
    if (message.role !== "assistant") continue;
    const missing = message.blocks.filter(
      (block): block is ToolCallBlock => block.type === "tool_call" && !resultIds.has(block.id),
    );
    if (missing.length === 0) continue;
    while (index + 1 < messages.length && messages[index + 1]?.role === "tool") {
      index += 1;
      out.push(messages[index]!);
    }
    const repair: Message = {
      id: `msg_restore_${index}_${repaired}`,
      role: "tool",
      createdAt: Date.now(),
      blocks: missing.map((call) => ({
        type: "tool_result",
        toolCallId: call.id,
        name: call.name,
        content: "interrupted by restart",
        isError: true,
      })),
    };
    out.push(repair);
    repaired += missing.length;
  }
  return { messages: out, repaired };
}

/** コアの組み立て。UI / CLI はこのクラスだけを使う。 */
export class Harness {
  readonly bus: EventBus;
  readonly sessions: SessionManager;
  readonly history: HistoryManager;
  readonly prompt: PromptAssembler;
  readonly tools: ToolRegistry;
  readonly jobs: JobManager;
  readonly providers: ProviderRegistry;
  readonly permissions: PermissionBroker;
  readonly hooks: HookRunner;
  readonly modules: ModuleHost;
  readonly config: HarnessConfig;

  #turnLoop: TurnLoop;
  #definitions: ModuleDefinition[];
  #logger: Logger;
  #queues = new Map<string, QueuedMessage[]>();
  #running = new Set<string>();
  #started = false;
  #stopping = false;

  constructor(options: HarnessOptions) {
    const config = configSchema.parse(options.config);
    this.config = config;
    const ids = options.ids ?? createIdGenerator();
    const bootId = options.bootId ?? ids.boot();
    const logger = options.logger ?? new Logger({
      ...(config.log?.level !== undefined ? { level: config.log.level } : {}),
      sink: () => {},
    });
    const now = options.now ?? (() => Date.now());
    const secrets = new SecretsBroker(config.secrets);

    this.#logger = logger;
    this.bus = new EventBus({
      bootId,
      now,
      onError: (error, event) => logger.error(`event handler failed for ${event.type}`, error),
    });
    this.sessions = new SessionManager(this.bus, ids, config.jobs?.autoWake ?? false);
    this.history = new HistoryManager(this.bus, ids, this.sessions, now);
    this.prompt = new PromptAssembler(this.bus, {
      ...(config.prompt?.system !== undefined ? { configPrompt: config.prompt.system } : {}),
    });
    this.tools = new ToolRegistry();
    this.providers = new ProviderRegistry();
    this.permissions = new PermissionBroker();
    this.hooks = new HookRunner((message, meta) => logger.warn(message, meta));
    this.jobs = new JobManager({
      bus: this.bus,
      sessions: this.sessions,
      ids,
      resultStore: options.resultStore ?? new MemoryResultStore(),
      maxConcurrentPerSession: options.maxConcurrentPerSession ?? config.jobs?.maxConcurrentPerSession ?? 8,
      defaultTimeoutMs: config.jobs?.defaultTimeoutMs ?? 300_000,
      maxTimeoutMs: config.jobs?.maxTimeoutMs ?? 900_000,
      maxSummaryChars: config.jobs?.maxSummaryChars ?? 200,
      now,
      log: (message, meta) => logger.warn(message, meta),
    });
    this.modules = new ModuleHost({
      bus: this.bus,
      tools: this.tools,
      jobs: this.jobs,
      history: this.history,
      prompt: this.prompt,
      sessions: this.sessions,
      hooks: this.hooks,
      providers: this.providers,
      permissions: this.permissions,
      secrets,
      log: logger,
      baseDir: options.baseDir ?? process.cwd(),
      ...(options.autoApprove !== undefined ? { autoApprove: options.autoApprove } : {}),
      ...(options.approve !== undefined ? { approve: options.approve } : {}),
      sessionRestore: {
        listRestorable: () => this.listRestorable(),
        restore: (sessionId) => this.restoreSession(sessionId),
      },
      approvals: new ApprovalManager(
        new ApprovalStore(options.approvalsPath ?? approvalsFile(), logger),
        this.bus,
        logger,
      ),
    });
    this.#turnLoop = new TurnLoop({
      bus: this.bus,
      sessions: this.sessions,
      history: this.history,
      prompt: this.prompt,
      tools: this.tools,
      jobs: this.jobs,
      providers: this.providers,
      hooks: this.hooks,
      secrets,
      log: logger,
      ids,
      maxSteps: options.maxSteps ?? 50,
      overflowRatio: options.overflowRatio ?? config.context?.overflowRatio ?? 0.8,
      maxNotificationChars: options.maxNotificationChars ?? config.jobs?.maxNotificationChars ?? 2000,
      hasCompactor: () => this.modules.hasRole("compactor"),
    });

    this.#definitions = options.modules ?? [];
    this.#registerCoreTools();
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    try {
      await this.modules.load(this.#definitions);
      if (this.providers.size === 0) throw new Error("no provider registered");
      if (this.modules.hasRole("result-store")) {
        this.jobs.setResultStore(
          new RoleResultStore((method, args) => this.modules.callRole("result-store", method, args)),
        );
      }
    } catch (error) {
      await this.modules.dispose();
      throw error;
    }
    this.#started = true;
    this.bus.emit(
      "core.started",
      { v: 1, version: CORE_VERSION, modules: this.modules.loadedNames },
      { source: "core" },
    );

    if (this.config.restore === "last" && this.modules.hasRole("session-store")) {
      try {
        const latest = await this.modules.callRole<Session | undefined>(
          "session-store",
          "latestRestorable",
        );
        if (latest) await this.restoreSession(latest.id);
      } catch (error) {
        this.#logger.error("auto restore failed", error);
      }
    }
  }

  async stop(reason = "normal"): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.bus.emit("core.stopping", { v: 1, reason }, { source: "core" });
    this.#turnLoop.cancelAll("system", "shutdown");
    this.jobs.stopAll("system");
    await this.flushPersistence();
    await this.modules.dispose();
    this.#started = false;
  }

  async flushPersistence(): Promise<void> {
    await this.jobs.flush();
    for (const role of ["history-store", "session-store", "result-store"] as const) {
      if (!this.modules.hasRole(role)) continue;
      try {
        await this.modules.callRole(role, "flush");
      } catch {
        // store modules without flush are fine
      }
    }
  }

  async listRestorable(): Promise<Session[]> {
    if (!this.modules.hasRole("session-store")) return [];
    return this.modules.callRole<Session[]>("session-store", "listRestorable");
  }

  async restoreSession(sessionId: string): Promise<Session> {
    if (!this.modules.hasRole("session-store")) throw new Error("session-store is not available");
    if (!this.modules.hasRole("history-store")) throw new Error("history-store is not available");
    const existing = this.sessions.tryGet(sessionId);
    if (existing) {
      if (existing.state !== "error") throw new Error(`session is already loaded: ${sessionId}`);
      this.sessions.remove(sessionId);
      this.history.deleteSession(sessionId);
    }
    const saved = await this.modules.callRole<Session | undefined>("session-store", "load", sessionId);
    if (!saved) throw new Error(`session not found: ${sessionId}`);
    if (saved.state === "closed") throw new Error(`closed session cannot be restored: ${sessionId}`);

    const restoring: Session = { ...saved, state: "restoring" };
    this.sessions.restorePrepared(restoring);
    try {
      try {
        this.providers.getModelInfo(saved.model);
      } catch {
        throw new Error(`model/provider unavailable for restored session: ${saved.model}`);
      }
      const messages = await this.modules.callRole<Message[]>("history-store", "loadMessages", sessionId);
      const repaired = repairDanglingToolCalls(messages);
      if (repaired.repaired > 0) {
        this.#logger.warn(`restored session ${sessionId}: synthesized ${repaired.repaired} interrupted tool_result(s)`);
      }
      this.history.restore(sessionId, repaired.messages);
      if (this.modules.hasRole("result-store")) {
        const jobs = await this.modules.callRole<Job[]>("result-store", "listBySession", { sessionId });
        this.jobs.restoreJobs(jobs);
      }
      this.sessions.setState(sessionId, "idle");
      this.bus.emit(
        "session.restored",
        { v: 1, sessionId },
        { source: "core", sessionId },
      );
      return this.sessions.get(sessionId);
    } catch (error) {
      this.sessions.setState(sessionId, "error");
      throw error;
    }
  }

  createSession(model?: string, options?: { parentId?: string; autoWake?: boolean }): Session {
    return this.sessions.create({
      model: model ?? this.config.models.default,
      ...(options?.parentId !== undefined ? { parentId: options.parentId } : {}),
      ...(options?.autoWake !== undefined ? { autoWake: options.autoWake } : {}),
    });
  }

  getSession(sessionId: string): Session {
    return this.sessions.get(sessionId);
  }

  closeSession(sessionId: string, reason?: string): void {
    const closed = this.sessions.close(sessionId, reason);
    for (const session of closed) this.jobs.cancelBySession(session.id, "system", reason ?? "session closed");
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.history.deleteSession(sessionId);
    await this.jobs.deleteSession(sessionId);
    await this.flushPersistence();
  }

  failModule(name: string, error: { code: string; message: string } = { code: "module_died", message: "module died" }): void {
    this.modules.failModule(name, error);
  }

  send(sessionId: string, text: string): Promise<void> {
    if (!this.#started) return Promise.reject(new Error("harness is not started"));
    if (this.#stopping) return Promise.reject(new Error("harness is stopping"));
    const session = this.sessions.get(sessionId);
    if (session.state === "closed" || session.state === "restoring") {
      return Promise.reject(new Error(`session is not accepting input: ${session.state}`));
    }
    return new Promise((resolve, reject) => {
      const queue = this.#queues.get(sessionId) ?? [];
      queue.push({ text, resolve, reject });
      this.#queues.set(sessionId, queue);
      if (!this.#running.has(sessionId)) void this.#drain(sessionId);
    });
  }

  cancel(sessionId: string, by: "ai" | "user" | "timeout" | "system" = "user", reason?: string): boolean {
    return this.#turnLoop.cancel(sessionId, by, reason);
  }

  on(type: string, handler: (event: EventEnvelope) => void): () => void {
    return this.bus.on(type, handler);
  }

  models(): ModelInfo[] {
    return this.providers.models();
  }

  async #drain(sessionId: string): Promise<void> {
    this.#running.add(sessionId);
    try {
      for (;;) {
        const item = this.#queues.get(sessionId)?.shift();
        if (!item) break;
        try {
          await this.#turnLoop.run(this.sessions.get(sessionId), item.text);
          item.resolve();
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.#running.delete(sessionId);
      if ((this.#queues.get(sessionId)?.length ?? 0) > 0) void this.#drain(sessionId);
    }
  }

  #registerCoreTools(): void {
    const waitTool: ToolDefinition = {
      name: "wait",
      description: "Wait for jobs by id. Returns current job statuses. Does not cancel jobs.",
      mode: "sync",
      input: z.object({
        ids: z.array(z.string()).min(1),
        timeoutMs: z.number().int().positive(),
      }),
      handler: async (args, ctx) => {
        const { ids, timeoutMs } = args as { ids: string[]; timeoutMs: number };
        const jobs = await this.jobs.wait(ids, timeoutMs, ctx.sessionId);
        if (jobs.length !== ids.length) {
          return { content: JSON.stringify({ error: "job_not_found_or_out_of_scope" }), isError: true };
        }
        return {
          content: JSON.stringify(
            jobs.map((job) => ({ id: job.id, status: job.status, summary: job.summary ?? "", size: job.size ?? 0 })),
          ),
          summary: `waited for ${jobs.length} job(s)`,
        };
      },
    };

    const cancelTool: ToolDefinition = {
      name: "cancel",
      description: "Cancel a job in your session or a descendant session.",
      mode: "sync",
      input: z.object({ id: z.string() }),
      handler: (args, ctx) => {
        const { id } = args as { id: string };
        const visible = this.jobs.listJobs(ctx.sessionId).some((job) => job.id === id);
        if (!visible) return { content: "job not found or out of scope", isError: true };
        const job = this.jobs.cancel(id, "ai", "cancelled by ai");
        return { content: JSON.stringify(job ?? { id, status: "unknown" }), summary: "job cancelled" };
      },
    };

    const readResultTool: ToolDefinition = {
      name: "read_result",
      description: "Read a job result body by id. Supports offset and limit.",
      mode: "sync",
      input: z.object({
        id: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200_000).optional(),
      }),
      handler: async (args, ctx) => {
        const { id, offset, limit } = args as { id: string; offset?: number; limit?: number };
        try {
          const result = await this.jobs.readResult(id, ctx.sessionId, offset ?? 0, limit ?? 20_000);
          return { content: JSON.stringify(result), summary: `read ${result.content.length} chars` };
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    };

    const listJobsTool: ToolDefinition = {
      name: "list_jobs",
      description: "List jobs started by your session or descendants, optionally filtered by status.",
      mode: "sync",
      input: z.object({
        status: z.enum(["running", "done", "failed", "cancelled"]).optional(),
      }),
      handler: (args, ctx) => {
        const { status } = args as { status?: JobStatus };
        const jobs = this.jobs.listJobs(ctx.sessionId, status).map((job) => ({
          id: job.id,
          status: job.status,
          tool: job.tool,
          callId: job.callId,
          ...(job.summary !== undefined ? { summary: job.summary } : {}),
          ...(job.size !== undefined ? { size: job.size } : {}),
        }));
        return { content: JSON.stringify(jobs), summary: `${jobs.length} job(s)` };
      },
    };

    for (const tool of [waitTool, cancelTool, readResultTool, listJobsTool]) {
      this.tools.register(tool, "core");
    }
  }
}
