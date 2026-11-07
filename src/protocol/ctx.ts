import type { CoreEvent } from "./events.ts";
import type { JobDoneInput, JobFailInput } from "./jobs.ts";
import type { Message, NewMessage } from "./messages.ts";
import type { PromptSegment, PromptSegmentInput } from "./prompt.ts";
import type { Session } from "./session.ts";
import type { ToolDefinition } from "./tools.ts";

export type Unsubscribe = () => void;

export type BusApi = {
  on(type: string, handler: (event: CoreEvent) => void): Unsubscribe;
  once(type: string, handler: (event: CoreEvent) => void): Unsubscribe;
  /** モジュール独自イベント用。コア予約イベントは発行できない。 */
  emit(type: string, payload: unknown, sessionId?: string): void;
};

export type ToolApi = {
  register(def: ToolDefinition): void;
  unregister(name: string): void;
};

export type HistoryApi = {
  read(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  get(sessionId: string, messageId: string): Promise<Message | undefined>;
  append(sessionId: string, message: NewMessage): Promise<Message>;
  appendBatch(sessionId: string, messages: NewMessage[]): Promise<Message[]>;
  /**
   * 永続化モジュールが保存済みの履歴をコアへ戻す。
   * history-store ロールかつ history.append 権限が必要。
   */
  load(sessionId: string, messages: Message[]): Promise<void>;
  /** compactor のみ。コアのメモリを書き換え、history.rewritten を発行する。 */
  rewrite(sessionId: string, messages: Message[], reason: string): Promise<void>;
  count(sessionId: string): Promise<number>;
};

export type PromptApi = {
  contribute(segment: PromptSegmentInput): void;
  remove(id: string): void;
  list(): PromptSegment[];
};

export type SessionApi = {
  get(sessionId: string): Session;
  create(opts: { model: string; parentId?: string }): Promise<Session>;
  fork(sessionId: string, opts?: { model?: string }): Promise<Session>;
  close(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): void;
};

export type AgentApi = {
  spawn(opts: {
    parentSessionId: string;
    prompt?: string;
    volatile?: string;
    model?: string;
    task: string;
  }): Promise<{ sessionId: string }>;
  message(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string, opts?: { reason?: string }): Promise<void>;
};

export type HookType = "prompt.assemble" | "tool.before" | "compaction.decide";

export type HookApi = {
  register(type: HookType, handler: (input: unknown) => unknown): Unsubscribe;
};

export type FsApi = {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
};

export type NetApi = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

export type EnvApi = {
  get(name: string): string | undefined;
};

export type SecretsApi = {
  /** プロバイダーの stream() 実行中のみ取得できる。 */
  get(name: string): string;
};

export type ModulesApi = {
  call<T = unknown>(name: string, method: string, args?: unknown): Promise<T>;
};

export type LogApi = {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
};

/** 非同期ツールの完了をコアへ知らせる。ジョブごとにちょうど 1 回だけ呼ぶ。 */
export type JobsApi = {
  done(jobId: string, input: JobDoneInput): void;
  fail(jobId: string, input: JobFailInput): void;
};

/** モジュールの init に渡される唯一の窓口。 */
export type ModuleContext = {
  name: string;
  bus: BusApi;
  tools: ToolApi;
  jobs: JobsApi;
  history: HistoryApi;
  prompt: PromptApi;
  session: SessionApi;
  agent: AgentApi;
  hooks: HookApi;
  fs: FsApi;
  net: NetApi;
  env: EnvApi;
  secrets: SecretsApi;
  modules: ModulesApi;
  log: LogApi;
};
