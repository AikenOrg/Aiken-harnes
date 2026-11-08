import type { ReasoningParams } from "./reasoning.ts";

/** セッションの状態。履歴や永続化とは独立にコアが保持する。 */
export type SessionState = "restoring" | "active" | "idle" | "closed" | "error";

/** コアが最小限保持するセッション情報。 */
export type Session = {
  id: string;
  parentId?: string;
  state: SessionState;
  /** 現在選択中のモデル (ModelInfo.id)。 */
  model: string;
  /**
   * アイドル中にジョブが完了したとき、新しいターンを自動で始めるか。
   * 最上位セッションの既定は config、サブエージェントの既定は true。
   */
  autoWake?: boolean;
  /** 直近のモデル呼び出しでプロバイダーが返した usage.input。 */
  lastInputTokens?: number;
  /** このセッションに許可されたツール名。未指定は全ツール。 */
  toolNames?: string[];
  /** セッション単位の reasoning 上書き。未指定は config の既定。 */
  reasoning?: ReasoningParams;
  /** reasoning 指定が無視された理由（UI 表示・診断用）。 */
  reasoningIgnored?: string;
  createdAt: number;
};
