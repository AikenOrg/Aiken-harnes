import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { EventEnvelope } from "../../protocol/events.ts";
import type { Job, JobResult, JobStatus } from "../../protocol/jobs.ts";
import type { Message, MessageRole } from "../../protocol/messages.ts";
import type { ModuleContext, ModuleExports } from "../../protocol/ctx.ts";
import type { Session, SessionState } from "../../protocol/session.ts";
import { defaultDbPath } from "../../shared/paths.ts";

const SCHEMA_VERSION = 1;

const configSchema = z.object({
  path: z.string().optional(),
  ttlDays: z.number().int().positive().default(30),
  cleanupIntervalMs: z.number().int().positive().default(6 * 60 * 60 * 1000),
  busyTimeoutMs: z.number().int().positive().default(5_000),
  batchMs: z.number().int().nonnegative().default(50),
  batchSize: z.number().int().positive().default(100),
});

export type StoreSqliteConfig = z.infer<typeof configSchema>;

type SessionRow = {
  id: string;
  parent_id: string | null;
  state: string;
  model: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  meta_json: string | null;
};

type MessageRow = {
  session_id: string;
  seq: number;
  id: string;
  role: string;
  content_json: string;
  interrupted: number;
  created_at: number;
};

type JobRow = {
  job_id: string;
  session_id: string;
  call_id: string;
  tool: string;
  status: string;
  notified: number;
  summary: string | null;
  size: number | null;
  result: Uint8Array | null;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
};

function rowSession(row: SessionRow): Session {
  let meta: { autoWake?: boolean; lastInputTokens?: number } = {};
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json) as { autoWake?: boolean; lastInputTokens?: number };
    } catch {
      meta = {};
    }
  }
  const session: Session = {
    id: row.id,
    state: row.state as SessionState,
    model: row.model,
    createdAt: row.created_at,
  };
  if (row.parent_id !== null) session.parentId = row.parent_id;
  if (meta.autoWake !== undefined) session.autoWake = meta.autoWake;
  if (meta.lastInputTokens !== undefined) session.lastInputTokens = meta.lastInputTokens;
  return session;
}

function rowMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    role: row.role as MessageRole,
    blocks: JSON.parse(row.content_json) as Message["blocks"],
    createdAt: row.created_at,
  };
  if (row.interrupted === 1) message.interrupted = true;
  return message;
}

function rowJob(row: JobRow): Job {
  const job: Job = {
    id: row.job_id,
    sessionId: row.session_id,
    ownerSessionId: row.session_id,
    callId: row.call_id,
    tool: row.tool,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    notified: row.notified === 1,
  };
  if (row.summary !== null) job.summary = row.summary;
  if (row.size !== null) job.size = row.size;
  if (row.finished_at !== null) job.endedAt = row.finished_at;
  return job;
}

function encodeResult(result: string | Uint8Array | undefined): Uint8Array | null {
  if (result === undefined) return null;
  return typeof result === "string" ? new TextEncoder().encode(result) : result;
}

/** SQLite の唯一の書き込み担当。全ての書き込みを 1 本のキューで直列化する。 */
export class SqliteStore {
  #db: Database;
  #ctx: ModuleContext;
  #queue: Promise<unknown> = Promise.resolve();
  #ttlDays: number;
  #cleanupTimer: ReturnType<typeof setInterval> | undefined;
  #batchMs: number;
  #batchSize: number;
  #pendingMessages: Array<{ sessionId: string; message: Message; seq: number }> = [];
  #batchTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(db: Database, ctx: ModuleContext, config: StoreSqliteConfig) {
    this.#db = db;
    this.#ctx = ctx;
    this.#ttlDays = config.ttlDays;
    this.#batchMs = config.batchMs;
    this.#batchSize = config.batchSize;
  }

  static async open(config: StoreSqliteConfig, ctx: ModuleContext): Promise<SqliteStore> {
    const path = config.path ?? defaultDbPath();
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA synchronous = NORMAL;`);
    db.exec(`PRAGMA foreign_keys = ON;`);
    db.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs};`);
    const store = new SqliteStore(db, ctx, config);
    store.#migrate();
    await store.deleteExpired(store.#ttlDays);
    store.#cleanupTimer = setInterval(() => {
      void store.deleteExpired(store.#ttlDays).catch((error: unknown) => {
        ctx.log.error("store-sqlite TTL cleanup failed", error);
      });
    }, config.cleanupIntervalMs);
    if (typeof store.#cleanupTimer === "object" && "unref" in store.#cleanupTimer) {
      store.#cleanupTimer.unref();
    }
    return store;
  }

  async flush(): Promise<void> {
    this.#flushPendingMessages();
    await this.#queue;
  }

  async close(): Promise<void> {
    if (this.#cleanupTimer !== undefined) clearInterval(this.#cleanupTimer);
    await this.flush();
    this.#db.close();
  }

  onEvent(event: EventEnvelope): void {
    try {
      switch (event.type) {
        case "session.created": {
          if (!event.sessionId) return;
          const payload = event.payload as { model?: string; parentId?: string; autoWake?: boolean };
          const sessionId = event.sessionId;
          this.#enqueueOrdered(() =>
            this.#upsertSession({
              id: sessionId,
              parentId: payload.parentId ?? null,
              state: "idle",
              model: payload.model ?? "unknown",
              createdAt: event.ts,
              updatedAt: event.ts,
              meta: { autoWake: payload.autoWake ?? payload.parentId !== undefined },
            }),
          );
          return;
        }
        case "session.closed": {
          if (!event.sessionId) return;
          const sessionId = event.sessionId;
          this.#enqueueOrdered(() => {
            this.#db
              .query("UPDATE sessions SET state = 'closed', updated_at = ?, closed_at = ? WHERE id = ?")
              .run(event.ts, event.ts, sessionId);
          });
          return;
        }
        case "session.restored": {
          if (!event.sessionId) return;
          const sessionId = event.sessionId;
          this.#enqueueOrdered(() => {
            this.#db
              .query("UPDATE sessions SET state = 'idle', updated_at = ? WHERE id = ?")
              .run(event.ts, sessionId);
          });
          return;
        }
        case "session.deleted": {
          const payload = event.payload as { sessionId?: string };
          const sessionId = payload.sessionId ?? event.sessionId;
          if (!sessionId) return;
          this.#pendingMessages = this.#pendingMessages.filter((item) => item.sessionId !== sessionId);
          this.#enqueueOrdered(() => {
            this.#db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
          });
          return;
        }
        case "message.appended": {
          const payload = event.payload as { messageId?: string };
          const sessionId = event.sessionId;
          if (!sessionId || !payload.messageId) return;
          void this.#ctx.history
            .get(sessionId, payload.messageId)
            .then((message) => {
              if (!message) return;
              this.#queueMessage(sessionId, message, event.seq);
            })
            .catch((error: unknown) => this.#ctx.log.error("store-sqlite append failed", error));
          return;
        }
        case "history.rewritten": {
          const sessionId = event.sessionId;
          if (!sessionId) return;
          const rewriteSeq = event.seq;
          void this.#ctx.history
            .read(sessionId)
            .then((messages) => {
              this.#pendingMessages = this.#pendingMessages.filter(
                (item) => item.sessionId !== sessionId || item.seq > rewriteSeq,
              );
              // 置換は pending の後続バッチより先に実行する (前のバッチは捨てる)。
              return this.#enqueue(() => this.#replaceMessages(sessionId, messages));
            })
            .catch((error: unknown) => this.#ctx.log.error("store-sqlite rewrite failed", error));
          return;
        }
        case "job.running": {
          if (!event.sessionId) return;
          const payload = event.payload as { jobId: string; tool: string; callId: string };
          const sessionId = event.sessionId;
          this.#enqueueOrdered(() =>
            this.#upsertJob({
              id: payload.jobId,
              sessionId,
              ownerSessionId: sessionId,
              callId: payload.callId,
              tool: payload.tool,
              status: "running",
              createdAt: event.ts,
              notified: false,
            }),
          );
          return;
        }
        case "job.done": {
          const payload = event.payload as { jobId: string; summary: string; size: number };
          this.#enqueueOrdered(() => {
            this.#db
              .query(
                "UPDATE job_results SET status = 'done', summary = ?, size = ?, finished_at = ? WHERE job_id = ?",
              )
              .run(payload.summary, payload.size, event.ts, payload.jobId);
          });
          return;
        }
        case "job.failed": {
          const payload = event.payload as { jobId: string; error?: { code?: string; message?: string } };
          this.#enqueueOrdered(() => {
            this.#db
              .query(
                "UPDATE job_results SET status = 'failed', summary = ?, size = 0, error_code = ?, finished_at = ? WHERE job_id = ?",
              )
              .run(payload.error?.message ?? "failed", payload.error?.code ?? "failed", event.ts, payload.jobId);
          });
          return;
        }
        case "job.cancelled": {
          const payload = event.payload as { jobId: string; reason?: string };
          this.#enqueueOrdered(() => {
            this.#db
              .query(
                "UPDATE job_results SET status = 'cancelled', summary = ?, size = 0, error_code = 'cancelled', finished_at = ? WHERE job_id = ?",
              )
              .run(payload.reason ?? "cancelled", event.ts, payload.jobId);
          });
          return;
        }
        case "tool.completed":
        case "turn.ended": {
          void this.flush().catch((error: unknown) => this.#ctx.log.error("store-sqlite flush failed", error));
          return;
        }
        case "job.notified": {
          const payload = event.payload as { jobId: string };
          this.#enqueueOrdered(() => {
            this.#db.query("UPDATE job_results SET notified = 1 WHERE job_id = ?").run(payload.jobId);
          });
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.#ctx.log.error(`store-sqlite event failed: ${event.type}`, error);
    }
  }

  async put(job: Job, result?: string | Uint8Array): Promise<void> {
    await this.#enqueueOrdered(() => this.#upsertJob(job, result));
  }

  async get(
    jobId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<JobResult | undefined> {
    await this.flush();
    const row = this.#db.query("SELECT * FROM job_results WHERE job_id = ?").get(jobId) as JobRow | null;
    if (!row || row.status === "running") return undefined;
    const text = row.result ? new TextDecoder().decode(row.result) : "";
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20_000;
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.max(start, Math.min(start + limit, text.length));
    const result: JobResult = {
      jobId: row.job_id,
      tool: row.tool,
      status: row.status as JobResult["status"],
      summary: row.summary ?? "",
      size: row.size ?? text.length,
      content: text.slice(start, end),
      truncated: end < text.length,
    };
    if (end < text.length) result.nextOffset = end;
    return result;
  }

  async listBySession(sessionId: string, status?: JobStatus): Promise<Job[]> {
    await this.flush();
    const rows = status
      ? (this.#db
          .query("SELECT * FROM job_results WHERE session_id = ? AND status = ? ORDER BY created_at")
          .all(sessionId, status) as JobRow[])
      : (this.#db
          .query("SELECT * FROM job_results WHERE session_id = ? ORDER BY created_at")
          .all(sessionId) as JobRow[]);
    return rows.map(rowJob);
  }

  async listUnnotified(sessionId: string): Promise<Job[]> {
    await this.flush();
    const rows = this.#db
      .query(
        "SELECT * FROM job_results WHERE session_id = ? AND status != 'running' AND notified = 0 ORDER BY created_at",
      )
      .all(sessionId) as JobRow[];
    return rows.map(rowJob);
  }

  async markNotified(jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    await this.#enqueueOrdered(() => {
      const stmt = this.#db.query("UPDATE job_results SET notified = 1 WHERE job_id = ?");
      const tx = this.#db.transaction((ids: string[]) => {
        for (const id of ids) stmt.run(id);
      });
      tx(jobIds);
    });
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.#enqueueOrdered(() => {
      this.#db.query("DELETE FROM job_results WHERE session_id = ?").run(sessionId);
    });
  }

  async deleteExpired(ttlDays: number): Promise<number> {
    return this.#enqueueOrdered(() => {
      const cutoff = Date.now() - ttlDays * 86_400_000;
      const result = this.#db
        .query(
          "DELETE FROM job_results WHERE status != 'running' AND notified = 1 AND finished_at IS NOT NULL AND finished_at < ?",
        )
        .run(cutoff);
      return result.changes;
    });
  }

  async listRestorable(): Promise<Session[]> {
    await this.flush();
    const rows = this.#db
      .query("SELECT * FROM sessions WHERE state != 'closed' ORDER BY updated_at DESC")
      .all() as SessionRow[];
    return rows.map(rowSession);
  }

  async latestRestorable(): Promise<Session | undefined> {
    await this.flush();
    const row = this.#db
      .query(
        "SELECT * FROM sessions WHERE state != 'closed' AND parent_id IS NULL ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as SessionRow | null;
    return row ? rowSession(row) : undefined;
  }

  async load(sessionId: string): Promise<Session | undefined> {
    await this.flush();
    const row = this.#db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | null;
    return row ? rowSession(row) : undefined;
  }

  async loadMessages(sessionId: string): Promise<Message[]> {
    await this.flush();
    const rows = this.#db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as MessageRow[];
    return rows.map(rowMessage);
  }

  #migrate(): void {
    this.#db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.#db.query("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | null;
    if (row) {
      if (row.version !== SCHEMA_VERSION) {
        throw new Error(`unknown store-sqlite schema version: ${row.version}`);
      }
      return;
    }
    const tx = this.#db.transaction(() => {
      this.#db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          state TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER,
          meta_json TEXT
        );
        CREATE TABLE messages (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          role TEXT NOT NULL,
          content_json TEXT NOT NULL,
          interrupted INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE job_results (
          job_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          call_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          status TEXT NOT NULL,
          notified INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          size INTEGER,
          result BLOB,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX idx_messages_session ON messages(session_id, seq);
        CREATE INDEX idx_jobs_session ON job_results(session_id, status, notified);
        INSERT INTO schema_version(version) VALUES (${SCHEMA_VERSION});
      `);
    });
    tx();
  }

  #upsertSession(input: {
    id: string;
    parentId: string | null;
    state: string;
    model: string;
    createdAt: number;
    updatedAt: number;
    meta: Record<string, unknown>;
  }): void {
    this.#db
      .query(
        `INSERT INTO sessions (id, parent_id, state, model, created_at, updated_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           model = excluded.model,
           updated_at = excluded.updated_at,
           meta_json = excluded.meta_json`,
      )
      .run(
        input.id,
        input.parentId,
        input.state,
        input.model,
        input.createdAt,
        input.updatedAt,
        JSON.stringify(input.meta),
      );
  }

  #insertMessages(items: Array<{ sessionId: string; message: Message; seq: number }>): void {
    if (items.length === 0) return;
    const insert = this.#db.query(
      `INSERT INTO messages (session_id, seq, id, role, content_json, interrupted, created_at)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?, ?, ?)`,
    );
    const tx = this.#db.transaction((batch: Array<{ sessionId: string; message: Message; seq: number }>) => {
      for (const item of batch) {
        insert.run(
          item.sessionId,
          item.sessionId,
          item.message.id,
          item.message.role,
          JSON.stringify(item.message.blocks),
          item.message.interrupted === true ? 1 : 0,
          item.message.createdAt,
        );
      }
    });
    tx(items);
  }

  #replaceMessages(sessionId: string, messages: Message[]): void {
    const insert = this.#db.query(
      `INSERT INTO messages (session_id, seq, id, role, content_json, interrupted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.#db.transaction((items: Message[]) => {
      this.#db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      items.forEach((message, index) => {
        insert.run(
          sessionId,
          index + 1,
          message.id,
          message.role,
          JSON.stringify(message.blocks),
          message.interrupted === true ? 1 : 0,
          message.createdAt,
        );
      });
    });
    tx(messages);
  }

  #upsertJob(job: Job, result?: string | Uint8Array): void {
    this.#db
      .query(
        `INSERT INTO job_results
          (job_id, session_id, call_id, tool, status, notified, summary, size, result, error_code, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           session_id = excluded.session_id,
           call_id = excluded.call_id,
           tool = excluded.tool,
           status = excluded.status,
           notified = excluded.notified,
           summary = excluded.summary,
           size = excluded.size,
           result = COALESCE(excluded.result, job_results.result),
           created_at = excluded.created_at,
           finished_at = excluded.finished_at`,
      )
      .run(
        job.id,
        job.sessionId,
        job.callId,
        job.tool,
        job.status,
        job.notified === true ? 1 : 0,
        job.summary ?? null,
        job.size ?? null,
        encodeResult(result),
        job.createdAt,
        job.endedAt ?? null,
      );
  }

  #flushPendingMessages(): void {
    if (this.#batchTimer !== undefined) {
      clearTimeout(this.#batchTimer);
      this.#batchTimer = undefined;
    }
    if (this.#pendingMessages.length === 0) return;
    const batch = this.#pendingMessages.splice(0);
    void this.#enqueue(() => this.#insertMessages(batch)).catch((error: unknown) => {
      this.#ctx.log.error("store-sqlite message batch failed", error);
    });
  }

  #queueMessage(sessionId: string, message: Message, seq: number): void {
    this.#pendingMessages.push({ sessionId, message, seq });
    if (this.#pendingMessages.length >= this.#batchSize) {
      this.#flushPendingMessages();
      return;
    }
    if (this.#batchTimer !== undefined) return;
    this.#batchTimer = setTimeout(() => {
      this.#batchTimer = undefined;
      this.#flushPendingMessages();
    }, this.#batchMs);
    if (typeof this.#batchTimer === "object" && "unref" in this.#batchTimer) {
      this.#batchTimer.unref();
    }
  }

  #enqueueOrdered<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#flushPendingMessages();
    return this.#enqueue(operation);
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const methods: Record<string, (...args: unknown[]) => unknown> = {};
let store: SqliteStore | undefined;

const module: ModuleExports = {
  async init(ctx, rawConfig) {
    const config = configSchema.parse(rawConfig);
    store = await SqliteStore.open(config, ctx);

    methods.listRestorable = () => store!.listRestorable();
    methods.latestRestorable = () => store!.latestRestorable();
    methods.load = (sessionId: unknown) => store!.load(sessionId as string);
    methods.loadMessages = (sessionId: unknown) => store!.loadMessages(sessionId as string);
    methods.put = (args: unknown) => {
      const value = args as { job: Job; result?: string | Uint8Array };
      return store!.put(value.job, value.result);
    };
    methods.get = (args: unknown) => {
      const value = args as { jobId: string; offset?: number; limit?: number };
      return store!.get(value.jobId, {
        ...(value.offset !== undefined ? { offset: value.offset } : {}),
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
      });
    };
    methods.listBySession = (args: unknown) => {
      const value = args as { sessionId: string; status?: JobStatus };
      return store!.listBySession(value.sessionId, value.status);
    };
    methods.listUnnotified = (args: unknown) => {
      const value = args as { sessionId: string };
      return store!.listUnnotified(value.sessionId);
    };
    methods.markNotified = (args: unknown) => {
      const value = args as { jobIds: string[] };
      return store!.markNotified(value.jobIds);
    };
    methods.deleteBySession = (args: unknown) => {
      const value = args as { sessionId: string };
      return store!.deleteBySession(value.sessionId);
    };
    methods.deleteExpired = (args: unknown) => {
      const value = args as { ttlDays: number };
      return store!.deleteExpired(value.ttlDays);
    };
    methods.flush = () => store!.flush();

    const subscriptions = [
      "message.appended",
      "history.rewritten",
      "session.created",
      "session.closed",
      "session.restored",
      "session.deleted",
      "job.running",
      "job.done",
      "job.failed",
      "job.cancelled",
      "job.notified",
      "tool.completed",
      "turn.ended",
    ];
    for (const type of subscriptions) {
      ctx.bus.on(type, (event) => store?.onEvent(event));
    }
    ctx.bus.on("core.stopping", () => {
      void store?.flush().catch((error: unknown) => ctx.log.error("store-sqlite flush failed", error));
    });
  },

  async dispose() {
    if (store) {
      await store.close();
      store = undefined;
    }
  },

  methods,
};

export { configSchema as storeSqliteConfigSchema };
export default module;
export const init = module.init;
export const dispose = module.dispose;
export const methodTable = methods;
