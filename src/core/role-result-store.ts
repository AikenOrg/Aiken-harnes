import type { Job, JobResult, JobStatus } from "../protocol/jobs.ts";
import type { ResultStore, ResultStoreGetOptions } from "./jobs.ts";

export type RoleCaller = (method: string, args?: unknown) => Promise<unknown>;

/** result-store ロールのモジュール API を ResultStore として使うアダプタ。 */
export class RoleResultStore implements ResultStore {
  #call: RoleCaller;

  constructor(call: RoleCaller) {
    this.#call = call;
  }

  async put(job: Job, result?: string | Uint8Array): Promise<void> {
    await this.#call("put", {
      job,
      ...(result !== undefined ? { result } : {}),
    });
  }

  async get(jobId: string, options: ResultStoreGetOptions = {}): Promise<JobResult | undefined> {
    return (await this.#call("get", {
      jobId,
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    })) as JobResult | undefined;
  }

  async listBySession(sessionId: string, status?: JobStatus): Promise<Job[]> {
    return (await this.#call("listBySession", {
      sessionId,
      ...(status !== undefined ? { status } : {}),
    })) as Job[];
  }

  async listUnnotified(sessionId: string): Promise<Job[]> {
    return (await this.#call("listUnnotified", { sessionId })) as Job[];
  }

  async markNotified(jobIds: string[]): Promise<void> {
    await this.#call("markNotified", { jobIds });
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.#call("deleteBySession", { sessionId });
  }

  async deleteExpired(ttlDays: number): Promise<number> {
    return (await this.#call("deleteExpired", { ttlDays })) as number;
  }

  async flush(): Promise<void> {
    await this.#call("flush");
  }
}
