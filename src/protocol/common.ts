/** キャンセルを要求した主体。job.cancelled / tool.cancelled の `by` に載る。 */
export type CancelBy = "ai" | "user" | "timeout" | "system";

/** モデルストリームの終了理由。 */
export type StopReason = "end" | "tool_use" | "length" | "error";

/** トークン使用量。cacheRead はキャッシュから読んだ入力トークン数。 */
export type Usage = {
  input: number;
  output: number;
  cacheRead?: number;
};

export type IsoTimestamp = number;
