/** キャンセルを要求した主体。job.cancelled / tool.cancelled の `by` に載る。 */
export type CancelBy = "ai" | "user" | "timeout" | "system";

/** モデルストリームの終了理由。 */
export type StopReason = "end" | "tool_use" | "length" | "error";

/** トークン使用量。cacheRead はキャッシュから読んだ入力トークン数。 */
export type Usage = {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  /** reasoning / thinking に使われたトークン数（返すモデルのみ）。 */
  reasoning?: number | undefined;
};

/** イベント・ジョブ・ツールで共通に使うエラー表現。 */
export type HarnessError = {
  code: string;
  message: string;
};

/** 同時ジョブ上限の超過。実行中のジョブ ID を AI に渡して整理させる。 */
export type JobLimitError = HarnessError & {
  runningJobIds: string[];
};

/** コアが使うエラーコード。モジュール固有のコードはこの接頭辞を使わない。 */
export const ERROR_CODES = {
  moduleDied: "module_died",
  jobTimeout: "job_timeout",
  tooManyJobs: "too_many_jobs",
  interrupted: "interrupted",
  denied: "denied",
  contextOverflow: "context_overflow",
  maxDepthExceeded: "max_depth_exceeded",
  tooManyChildren: "too_many_children",
  tooManyAgents: "too_many_agents",
  invalidTools: "invalid_tools",
  agentRouteDenied: "agent_route_denied",
  agentClosed: "agent_closed",
  unknownJob: "unknown_job",
  invalidState: "invalid_state",
  permissionDenied: "permission_denied",
  notFound: "not_found",
  aborted: "aborted",
  internal: "internal",
} as const;

export type CoreErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
