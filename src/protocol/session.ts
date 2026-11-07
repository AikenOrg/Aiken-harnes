/** セッションの状態。履歴や永続化とは独立にコアが保持する。 */
export type SessionState = "active" | "idle" | "closed" | "error";

/** コアが最小限保持するセッション情報。 */
export type Session = {
  id: string;
  parentId?: string;
  state: SessionState;
  /** 現在選択中のモデル (ModelInfo.id)。 */
  model: string;
  createdAt: number;
};
