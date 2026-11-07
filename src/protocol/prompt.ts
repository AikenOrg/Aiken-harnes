/**
 * プロンプト断片の安定度。
 * static -> session -> volatile のブロック順をコアが強制する。
 */
export type PromptStability = "static" | "session" | "volatile";

/** システムプロンプトの断片。 */
export type PromptSegment = {
  /** 一意な ID。例: "config.system", "core.rules", "module:foo" */
  id: string;
  /** 登録元。config / core / モジュール名。 */
  source: string;
  stability: PromptStability;
  /** 同一安定度ブロック内でのみ意味を持つ。大きいほど前。 */
  priority: number;
  content: string;
};

/** モジュールが登録する断片。source はコアが埋める。 */
export type PromptSegmentInput = {
  id: string;
  stability: PromptStability;
  priority: number;
  content: string;
};

/** 結合済みプロンプト。 */
export type AssembledPrompt = {
  segments: PromptSegment[];
  /** static ブロックの末尾 index。プロバイダーのキャッシュヒント。 */
  cacheBoundary: number;
  /** static 部分のハッシュ (診断用)。 */
  hash: string;
};
