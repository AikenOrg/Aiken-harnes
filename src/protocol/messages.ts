import type { JobNotification } from "./jobs.ts";

export type MessageRole = "system" | "user" | "assistant" | "tool" | "notification";

export type TextBlock = {
  type: "text";
  text: string;
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

export type Block = TextBlock | ToolCallBlock | ToolResultBlock | NotificationBlock;

export type Message = {
  id: string;
  role: MessageRole;
  blocks: Block[];
  createdAt: number;
};

/** 履歴へ追記するメッセージ。id と createdAt はコアが採番する。 */
export type NewMessage = Omit<Message, "id" | "createdAt">;
