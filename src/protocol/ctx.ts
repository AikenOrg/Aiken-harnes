import type { EventEnvelope } from "./events.ts";
import type { Job, JobDoneInput, JobFailInput, JobResult, JobStatus } from "./jobs.ts";
import type { Message, NewMessage } from "./messages.ts";
import type { PromptSegment, PromptSegmentInput } from "./prompt.ts";
import type { ModelInfo } from "./provider.ts";
import type { Provider } from "./provider.ts";
import type { ReasoningParams } from "./reasoning.ts";
import type { Session } from "./session.ts";
import type { ToolDefinition } from "./tools.ts";

export type Unsubscribe = () => void;

export type BusApi = {
  on(type: string, handler: (event: EventEnvelope) => void): Unsubscribe;
  once(type: string, handler: (event: EventEnvelope) => void): Unsubscribe;
  /** モジュール独自イベント用。コア予約イベントは発行できない。 */
  emit(type: string, payload: unknown, sessionId?: string): void;
};

export type ToolApi = {
  register(def: ToolDefinition): void;
  unregister(name: string): void;
};

export type ProviderApi = {
  register(provider: Provider): void;
};

export type HistoryApi = {
  read(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  get(sessionId: string, messageId: string): Promise<Message | undefined>;
  append(sessionId: string, message: NewMessage): Promise<Message>;
  appendBatch(sessionId: string, messages: NewMessage[]): Promise<Message[]>;
  /**
   * 永続化モジュールが保存済みの履歴をコアへ戻す。
   * history.restore 権限と history-store ロールが必要。
   * 状態が restoring で履歴が空のセッションにだけ実行できる。
   */
  restore(sessionId: string, messages: Message[]): Promise<void>;
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
  /** すべてのセッション。UI ロール向け。 */
  list(): Promise<Session[]>;
  /** 登録済みモデル。UI の新規セッション作成用。 */
  models(): ModelInfo[];
  create(opts: { model: string; parentId?: string; autoWake?: boolean }): Promise<Session>;
  fork(sessionId: string, opts?: { model?: string }): Promise<Session>;
  /** 復元可能なセッションの一覧 (session-store の role API 経由)。 */
  listRestorable(): Promise<Session[]>;
  /** 保存済みセッションを restoring 状態で開き、履歴の復元を開始する。 */
  restore(sessionId: string): Promise<Session>;
  close(sessionId: string): Promise<void>;
  /** closed のセッションだけ削除できる。 */
  delete(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): void;
  /** reasoning の強度を変更する。次のターンから反映する。 */
  setReasoning(sessionId: string, params?: ReasoningParams): Promise<void>;
  /** ユーザー入力をキューへ積む。UI ロール向け。 */
  send(sessionId: string, text: string): Promise<void>;
  /** 現在のターンをユーザー操作としてキャンセルする。UI ロール向け。 */
  cancel(sessionId: string, opts?: { reason?: string }): Promise<void>;
};

export type AgentSpawnOptions = {
  parentSessionId: string;
  task: string;
  prompt?: string;
  volatile?: string;
  model?: string;
  tools?: string[];
  autoWake?: boolean;
  reasoning?: ReasoningParams;
};

export type AgentApi = {
  spawn(opts: AgentSpawnOptions): Promise<{ sessionId: string; jobId: string }>;
  send(fromSessionId: string, toSessionId: string, text: string): Promise<{ jobId: string }>;
  /** send の互換エイリアス。 */
  message(fromSessionId: string, toSessionId: string, text: string): Promise<{ jobId: string }>;
  cancel(fromSessionId: string, toSessionId: string, opts?: { reason?: string }): Promise<void>;
  /** 自分の子孫セッションを閉じる。子孫も再帰的に閉じる。 */
  close(fromSessionId: string, toSessionId: string, opts?: { reason?: string }): Promise<void>;
  list(fromSessionId: string): Promise<Session[]>;
};

export type HookType = "prompt.assemble" | "tool.before" | "compaction.decide" | "agent.route";

export type HookApi = {
  register(type: HookType, handler: (input: unknown) => unknown): Unsubscribe;
};

export type FsApi = {
  /** モジュールの作業ディレクトリ。相対パスの基準。 */
  readonly baseDir: string;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  realpath(path: string): Promise<string>;
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
  /** セッションが起動したジョブ。UI ロール向け。 */
  list(sessionId: string, status?: JobStatus): Promise<Job[]>;
  /** ジョブ結果の取得。UI ロール向け。 */
  read(jobId: string, opts?: { offset?: number; limit?: number }): Promise<JobResult>;
  /** 実行中ジョブのキャンセル。UI ロール向け。 */
  cancel(jobId: string, opts?: { reason?: string }): Promise<void>;
};

/** モジュールの init に渡される唯一の窓口。 */
export type ModuleContext = {
  name: string;
  bus: BusApi;
  tools: ToolApi;
  providers: ProviderApi;
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

/** モジュールがエクスポートする実装。manifest は別ファイル。 */
export type ModuleExports = {
  init(ctx: ModuleContext, config: Record<string, unknown>): Promise<void> | void;
  dispose?(): Promise<void> | void;
  methods?: Record<string, (...args: unknown[]) => unknown>;
};
