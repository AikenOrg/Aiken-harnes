import type { CancelBy } from "./common.ts";

/** 非同期ジョブの状態。終端状態から戻らない。 */
export type JobStatus = "running" | "done" | "failed" | "cancelled";

/** 通知・結果取得で扱う終端状態。 */
export type TerminalJobStatus = Exclude<JobStatus, "running">;

/** コアが保持するジョブのメタデータ。結果本体は result-store にある。 */
export type Job = {
  id: string;
  /** 通知先のセッション。 */
  sessionId: string;
  /** ジョブを起動したセッション。キャンセル範囲の判定に使う。 */
  ownerSessionId: string;
  toolCallId: string;
  name: string;
  status: JobStatus;
  createdAt: number;
  endedAt?: number;
  summary?: string;
  /** 結果本体のバイト数。 */
  size?: number;
  /** result-store 側の参照。 */
  resultRef?: string;
  cancelBy?: CancelBy;
};

/**
 * モデルへ渡す完了通知。固定 JSON であり、これ以外のフィールドを足さない。
 * 本体は read_result(id) で取得する。
 */
export type JobNotification = {
  id: string;
  status: TerminalJobStatus;
  summary: string;
  size: number;
};

/** read_result の戻り値。 */
export type JobResult = {
  id: string;
  status: TerminalJobStatus;
  summary: string;
  size: number;
  content: string;
  /** content が size より短い場合 true。 */
  truncated: boolean;
};
