import type { ZodType } from "zod";

export type ToolMode = "sync" | "async";

/** モデルへ渡すツール仕様。inputSchema は JSON Schema。 */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** manifest で宣言するツール。登録内容と一致しなければならない。 */
export type ToolDeclaration = {
  name: string;
  mode: ToolMode;
  /** async ツールのタイムアウト。config の上限を超える値は切り詰める。 */
  timeoutMs?: number;
};

/** ツール実行の戻り値。 */
export type ToolResult = {
  content: string;
  isError?: boolean;
  /** 通知に載せる短い要約。省略時は content の先頭から生成する。 */
  summary?: string;
};

/** ツールハンドラに渡される実行コンテキスト。 */
export type ToolContext = {
  sessionId: string;
  toolCallId: string;
  /** キャンセル時に abort される。 */
  signal: AbortSignal;
  /** async ツールの場合のみ、コアが発行したジョブ ID。 */
  jobId?: string;
  reportProgress?: (message: string) => void;
};

/** モジュールが登録するツール定義。 */
export type ToolDefinition = {
  name: string;
  description: string;
  input: ZodType;
  mode: ToolMode;
  /** async ツールのタイムアウト。 */
  timeoutMs?: number;
  /** エージェント操作ツール。子の既定ツールから除外する。 */
  agentTool?: boolean;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult | void> | ToolResult | void;
};
