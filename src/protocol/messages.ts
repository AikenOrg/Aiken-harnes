import type { JobNotification } from "./jobs.ts";

export type MessageRole = "system" | "user" | "assistant" | "tool" | "notification";

export type TextBlock = {
  type: "text";
  text: string;
};

/** ユーザー入力の画像。data は base64 本体。 */
export type ImageBlock = {
  type: "image";
  mediaType: string;
  data: string;
  name?: string;
};

/**
 * モデルの reasoning / thinking。
 * `opaque` は Anthropic の signature や redacted_thinking の data など、
 * プロバイダーが次のリクエストで必要とする不透明データ。
 */
export type ReasoningBlock = {
  type: "reasoning";
  text: string;
  opaque?: unknown;
};

export type ToolCallBlock = {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
};

/**
 * 非同期ジョブの完了通知ブロック。
 * 1 つのメッセージに、完了順の通知をまとめて載せる。
 */
export type NotificationBlock = {
  type: "notification";
  entries: JobNotification[];
};

export type Block =
  | TextBlock
  | ImageBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | NotificationBlock;

export type Message = {
  id: string;
  role: MessageRole;
  blocks: Block[];
  createdAt: number;
  /** キャンセルで途切れたアシスタントメッセージ。テキストだけを保持する。 */
  interrupted?: boolean;
  /** 出力トークン上限 (length) で切り詰められたアシスタントメッセージ。 */
  truncated?: boolean;
};

/** 履歴へ追記するメッセージ。id と createdAt はコアが採番する。 */
export type NewMessage = Omit<Message, "id" | "createdAt">;
