import { ERROR_CODES, type CancelBy, type JobLimitError } from "../protocol/common.ts";
import type { Job, JobDoneInput, JobFailInput, JobResult, JobStatus, TerminalJobStatus } from "../protocol/jobs.ts";
import type { EventBus } from "./bus.ts";
import type { IdGenerator } from "./ids.ts";
import type { SessionManager } from "./sessions.ts";

export interface ResultStore {
  save(jobId: string, content: string | Uint8Array): Promise<{ ref: string; size: number }>;
  read(ref: string): Promise<string | Uint8Array | undefined>;
  delete(ref: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export class MemoryResultStore implements ResultStore {
  #items = new Map<string, string | Uint8Array>();

  async save(jobId: string, content: string | Uint8Array): Promise<{ ref: string; size: number }> {
    const ref = `mem_${jobId}`;
    this.#items.set(ref, content);
    return { ref, size: byteLength(content) };
  }

  async read(ref: string): Promise<string | Uint8Array | undefined> {
    return this.#items.get(ref);
  }

  async delete(ref: string): Promise<void> {
    this.#items.delete(ref);
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // メモリ実装はプロセス終了で消える。ジョブ単位の delete(ref) を使う。
  }
}

export type JobManagerOptions = {
  bus: EventBus;
  sessions: SessionManager;
  ids: IdGenerator;
  resultStore?: ResultStore;
  maxConcurrentPerSession?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxSummaryChars?: number;
  now?: () => number;
  log?: (message: string, meta?: unknown) => void;
};

export type CreatedJob = {
  job: Job;
  controller: AbortController;
  signal: AbortSignal;
  timeoutMs: number;
  module: string;
};

function isTerminal(status: JobStatus): status is TerminalJobStatus {
  return status !== "running";
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

function truncateSummary(summary: string, maxChars: number): string {
  const chars = [...summary];
  if (chars.length <= maxChars) return summary;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function asText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

/** ジョブ ID・状態・タイムアウト・通知キューを管理する。 */
export class JobManager {
  #jobs = new Map<string, Job>();
  #modules = new Map<string, string>();
  #controllers = new Map<string, AbortController>();
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #bus: EventBus;
  #sessions: SessionManager;
  #ids: IdGenerator;
  #resultStore: ResultStore;
  #maxConcurrentPerSession: number;
  #defaultTimeoutMs: number;
  #maxTimeoutMs: number;
  #maxSummaryChars: number;
  #now: () => number;
  #log: (message: string, meta?: unknown) => void;

  constructor(options: JobManagerOptions) {
    this.#bus = options.bus;
    this.#sessions = options.sessions;
    this.#ids = options.ids;
    this.#resultStore = options.resultStore ?? new MemoryResultStore();
    this.#maxConcurrentPerSession = options.maxConcurrentPerSession ?? 8;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.#maxTimeoutMs = options.maxTimeoutMs ?? 900_000;
    this.#maxSummaryChars = options.maxSummaryChars ?? 200;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  setMaxSummaryChars(value: number): void {
    this.#maxSummaryChars = value;
  }

  create(options: {
    sessionId: string;
    ownerSessionId: string;
    callId: string;
    tool: string;
    module: string;
    timeoutMs?: number;
  }): CreatedJob {
    const running = this.listRunning(options.sessionId);
    if (running.length >= this.#maxConcurrentPerSession) {
      const error: JobLimitError = {
        code: ERROR_CODES.tooManyJobs,
        message: `session ${options.sessionId} already has ${running.length} running jobs`,
        runningJobIds: running.map((job) => job.id),
      };
      throw error;
    }

    const timeoutMs = Math.min(
      options.timeoutMs ?? this.#defaultTimeoutMs,
      this.#maxTimeoutMs,
    );
    const controller = new AbortController();
    const job: Job = {
      id: this.#ids.job(),
      sessionId: options.sessionId,
      ownerSessionId: options.ownerSessionId,
      callId: options.callId,
      tool: options.tool,
      status: "running",
      timeoutMs,
      createdAt: this.#now(),
      notified: false,
    };
    this.#jobs.set(job.id, job);
    this.#modules.set(job.id, options.module);
    this.#controllers.set(job.id, controller);

    const timer = setTimeout(() => {
      this.cancel(job.id, "timeout", "job timeout");
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.#timers.set(job.id, timer);

    this.#bus.emit(
      "job.running",
      { v: 1, jobId: job.id, tool: job.tool, callId: job.callId },
      { source: "core", sessionId: job.sessionId },
    );
    return { job, controller, signal: controller.signal, timeoutMs, module: options.module };
  }

  done(jobId: string, module: string, input: JobDoneInput): void {
    const job = this.#jobs.get(jobId);
    if (!job || job.status !== "running") return;
    if (this.#modules.get(jobId) !== module) {
      this.#log(`job ${jobId} completed by unexpected module ${module}`);
      return;
    }
    const summary = truncateSummary(input.summary, this.#maxSummaryChars);
    const size = byteLength(input.result);
    job.status = "done";
    job.endedAt = this.#now();
    job.summary = summary;
    job.size = size;
    this.#clearTimer(jobId);
    this.#bus.emit(
      "job.done",
      { v: 1, jobId, callId: job.callId, tool: job.tool, summary, size },
      { source: "core", sessionId: job.sessionId },
    );
    void this.#resultStore
      .save(jobId, input.result)
      .then(({ ref }) => {
        job.resultRef = ref;
      })
      .catch((error: unknown) => {
        this.#log(`failed to save result for ${jobId}`, error);
      });
  }

  fail(jobId: string, module: string, input: JobFailInput): void {
    const job = this.#jobs.get(jobId);
    if (!job || job.status !== "running") return;
    if (this.#modules.get(jobId) !== module) {
      this.#log(`job ${jobId} failed by unexpected module ${module}`);
      return;
    }
    this.#finishFailed(job, input);
  }

  /** モジュール死亡時に、そのモジュールの実行中ジョブを failed にする。 */
  failModule(module: string, input: JobFailInput): void {
    for (const job of this.#jobs.values()) {
      if (job.status === "running" && this.#modules.get(job.id) === module) {
        this.#finishFailed(job, input);
      }
    }
  }

  cancel(jobId: string, by: CancelBy, reason?: string): Job | undefined {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
    if (isTerminal(job.status)) return job;

    job.status = "cancelled";
    job.cancelBy = by;
    job.endedAt = this.#now();
    job.summary = truncateSummary(reason ?? "cancelled", this.#maxSummaryChars);
    job.size = 0;
    this.#clearTimer(jobId);
    this.#controllers.get(jobId)?.abort();
    this.#controllers.delete(jobId);

    const payload: { v: 1; jobId: string; callId: string; by: CancelBy; reason?: string } = {
      v: 1,
      jobId,
      callId: job.callId,
      by,
    };
    if (reason !== undefined) payload.reason = reason;
    this.#bus.emit("job.cancelled", payload, { source: "core", sessionId: job.sessionId });
    return job;
  }

  cancelBySession(sessionId: string, by: CancelBy, reason?: string): void {
    for (const job of [...this.#jobs.values()]) {
      if (job.sessionId === sessionId && job.status === "running") this.cancel(job.id, by, reason);
    }
  }

  get(jobId: string): Job | undefined {
    return this.#jobs.get(jobId);
  }

  listRunning(sessionId: string): Job[] {
    return [...this.#jobs.values()].filter(
      (job) => job.sessionId === sessionId && job.status === "running",
    );
  }

  listJobs(callerSessionId: string, status?: JobStatus): Job[] {
    return [...this.#jobs.values()].filter((job) => {
      if (!this.#sessions.isSelfOrDescendant(callerSessionId, job.ownerSessionId)) return false;
      return status === undefined || job.status === status;
    });
  }

  pendingNotifications(sessionId: string): Job[] {
    return [...this.#jobs.values()].filter(
      (job) => job.sessionId === sessionId && isTerminal(job.status) && !job.notified,
    );
  }

  markNotified(jobIds: string[]): void {
    for (const jobId of jobIds) {
      const job = this.#jobs.get(jobId);
      if (!job || !isTerminal(job.status) || job.notified) continue;
      job.notified = true;
      this.#bus.emit("job.notified", { v: 1, jobId }, { source: "core", sessionId: job.sessionId });
    }
  }

  async wait(ids: string[], timeoutMs: number, callerSessionId: string): Promise<Job[]> {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      const jobs = ids
        .map((id) => this.#jobs.get(id))
        .filter((job): job is Job => job !== undefined && this.#sessions.isSelfOrDescendant(callerSessionId, job.ownerSessionId));
      if (jobs.length === ids.length && jobs.every((job) => isTerminal(job.status))) {
        this.#markDeliveredByWait(jobs);
        return jobs;
      }
      if (this.#now() >= deadline) {
        this.#markDeliveredByWait(jobs.filter((job) => isTerminal(job.status)));
        return jobs;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async readResult(
    jobId: string,
    callerSessionId: string,
    offset = 0,
    limit = 20_000,
  ): Promise<JobResult> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (!this.#sessions.isSelfOrDescendant(callerSessionId, job.ownerSessionId)) {
      throw new Error(`job ${jobId} is outside the caller's scope`);
    }
    if (!isTerminal(job.status)) throw new Error(`job ${jobId} is still running`);
    const ref = job.resultRef;
    const raw = ref ? await this.#resultStore.read(ref) : undefined;
    const text = raw === undefined ? "" : asText(raw);
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.max(start, Math.min(start + limit, text.length));
    const result: JobResult = {
      jobId: job.id,
      tool: job.tool,
      status: job.status,
      summary: job.summary ?? "",
      size: job.size ?? byteLength(text),
      content: text.slice(start, end),
      truncated: end < text.length,
    };
    if (end < text.length) result.nextOffset = end;
    return result;
  }

  async deleteSession(sessionId: string): Promise<void> {
    for (const job of [...this.#jobs.values()]) {
      if (job.sessionId === sessionId) {
        this.#clearTimer(job.id);
        this.#controllers.get(job.id)?.abort();
        if (job.resultRef !== undefined) await this.#resultStore.delete(job.resultRef);
        this.#jobs.delete(job.id);
        this.#modules.delete(job.id);
        this.#controllers.delete(job.id);
      }
    }
    await this.#resultStore.deleteSession(sessionId);
  }

  stopAll(by: CancelBy = "system"): void {
    for (const job of [...this.#jobs.values()]) {
      if (job.status === "running") this.cancel(job.id, by, "shutdown");
    }
  }

  #finishFailed(job: Job, input: JobFailInput): void {
    job.status = "failed";
    job.endedAt = this.#now();
    job.summary = truncateSummary(input.message, this.#maxSummaryChars);
    job.size = 0;
    this.#clearTimer(job.id);
    this.#controllers.get(job.id)?.abort();
    this.#controllers.delete(job.id);
    this.#bus.emit(
      "job.failed",
      { v: 1, jobId: job.id, callId: job.callId, tool: job.tool, error: input },
      { source: "core", sessionId: job.sessionId },
    );
  }

  #markDeliveredByWait(jobs: Job[]): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) job.notified = true;
    }
  }

  #clearTimer(jobId: string): void {
    const timer = this.#timers.get(jobId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(jobId);
  }
}
