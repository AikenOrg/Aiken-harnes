import { z } from "zod";
import type { CancelBy, HarnessError, StopReason, Usage } from "./common.ts";

/**
 * イベントペイロードの版。全ペイロードに `v: 1` を必須で載せる。
 * 破壊的変更をするときは版を上げ、購読側で分岐できるようにする。
 */
export const CORE_EVENT_VERSION = 1 as const;

const v = z.literal(CORE_EVENT_VERSION);

const errorSchema: z.ZodType<HarnessError> = z.object({
  code: z.string(),
  message: z.string(),
});

const usageSchema: z.ZodType<Usage> = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
});

const cancelBySchema: z.ZodType<CancelBy> = z.enum(["ai", "user", "timeout", "system"]);

const stopReasonSchema: z.ZodType<StopReason> = z.enum(["end", "tool_use", "length", "error"]);

/**
 * 全イベントのペイロード定義。TypeScript 型と zod スキーマと文書はここから生成する。
 *
 * 原則:
 * - 本文は持たず ID で参照する (本文は ctx.history / read_result で取得する)。
 * - 大きなデータを載せない。
 * - エラーは { code, message } に統一する。
 */
export const eventSchemas = {
  "user.message": z.object({
    v,
    text: z.string(),
  }),
  "user.cancel": z.object({
    v,
    reason: z.string().optional(),
  }),

  "session.created": z.object({
    v,
    parentId: z.string().optional(),
    model: z.string(),
  }),
  "session.closed": z.object({
    v,
    reason: z.string().optional(),
  }),
  "session.forked": z.object({
    v,
    fromSessionId: z.string(),
  }),

  "turn.started": z.object({
    v,
    turnId: z.string(),
  }),
  "turn.ended": z.object({
    v,
    turnId: z.string(),
    reason: z.enum(["completed", "cancelled", "error"]),
  }),

  "model.requested": z.object({
    v,
    turnId: z.string(),
    model: z.string(),
    messageCount: z.number().int().nonnegative(),
    toolCount: z.number().int().nonnegative(),
    promptHash: z.string(),
  }),
  "model.delta": z.object({
    v,
    turnId: z.string(),
    text: z.string(),
  }),
  "model.completed": z.object({
    v,
    turnId: z.string(),
    usage: usageSchema,
    stop: stopReasonSchema,
  }),
  "model.failed": z.object({
    v,
    turnId: z.string().optional(),
    error: errorSchema,
  }),

  "tool.requested": z.object({
    v,
    callId: z.string(),
    tool: z.string(),
    mode: z.enum(["sync", "async"]),
  }),
  "tool.started": z.object({
    v,
    callId: z.string(),
    tool: z.string(),
    jobId: z.string().optional(),
  }),
  "tool.completed": z.object({
    v,
    callId: z.string(),
    tool: z.string(),
    durationMs: z.number().int().nonnegative(),
    jobId: z.string().optional(),
  }),
  "tool.failed": z.object({
    v,
    callId: z.string(),
    tool: z.string(),
    error: errorSchema,
    durationMs: z.number().int().nonnegative().optional(),
  }),
  "tool.cancelled": z.object({
    v,
    callId: z.string(),
    tool: z.string(),
    by: cancelBySchema,
  }),

  "job.running": z.object({
    v,
    jobId: z.string(),
    tool: z.string(),
    callId: z.string(),
  }),
  "job.done": z.object({
    v,
    jobId: z.string(),
    callId: z.string(),
    tool: z.string(),
    summary: z.string(),
    size: z.number().int().nonnegative(),
  }),
  "job.failed": z.object({
    v,
    jobId: z.string(),
    callId: z.string(),
    tool: z.string(),
    error: errorSchema,
  }),
  "job.cancelled": z.object({
    v,
    jobId: z.string(),
    callId: z.string(),
    by: cancelBySchema,
    reason: z.string().optional(),
  }),
  "job.notified": z.object({
    v,
    jobId: z.string(),
  }),

  "message.appended": z.object({
    v,
    messageId: z.string(),
  }),
  "history.rewritten": z.object({
    v,
    reason: z.string(),
    beforeCount: z.number().int().nonnegative(),
    afterCount: z.number().int().nonnegative(),
  }),

  "prompt.assembled": z.object({
    v,
    segmentIds: z.array(z.string()),
    cacheBoundary: z.number().int().nonnegative(),
    hash: z.string(),
  }),

  "compaction.requested": z.object({
    v,
    reason: z.string(),
    tokenEstimate: z.number().int().nonnegative().optional(),
  }),
  "compaction.completed": z.object({
    v,
    beforeCount: z.number().int().nonnegative(),
    afterCount: z.number().int().nonnegative(),
  }),

  "agent.spawned": z.object({
    v,
    childSessionId: z.string(),
    parentSessionId: z.string(),
    model: z.string(),
  }),
  "agent.message": z.object({
    v,
    from: z.string(),
    to: z.string(),
    messageId: z.string(),
  }),
  "agent.cancelled": z.object({
    v,
    sessionId: z.string(),
    by: cancelBySchema,
  }),

  "module.loaded": z.object({
    v,
    module: z.string(),
    version: z.string(),
    roles: z.array(z.string()),
    critical: z.boolean(),
  }),
  "module.failed": z.object({
    v,
    module: z.string(),
    error: errorSchema,
  }),
  "module.disabled": z.object({
    v,
    module: z.string(),
    reason: z.string(),
  }),

  "permission.requested": z.object({
    v,
    module: z.string(),
    permissions: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  "permission.granted": z.object({
    v,
    module: z.string(),
    permissions: z.array(z.string()),
  }),
  "permission.denied": z.object({
    v,
    module: z.string(),
    cap: z.string(),
    hook: z.string().optional(),
    error: errorSchema,
  }),
  "permission.violation": z.object({
    v,
    module: z.string(),
    cap: z.string(),
    error: errorSchema,
  }),

  "core.started": z.object({
    v,
    version: z.string(),
    modules: z.array(z.string()),
  }),
  "core.stopping": z.object({
    v,
    reason: z.string(),
  }),
} as const;

export type CoreEventType = keyof typeof eventSchemas;

export type EventPayload<TType extends CoreEventType> = z.infer<
  (typeof eventSchemas)[TType]
>;

export type EventPayloads = {
  [K in CoreEventType]: EventPayload<K>;
};

/** イベントの意味。生成文書の説明列に使う。 */
export const EVENT_DESCRIPTIONS = {
  "user.message": "ユーザー入力。",
  "user.cancel": "ユーザーによるキャンセル要求。",
  "session.created": "セッション作成。",
  "session.closed": "セッション終了。",
  "session.forked": "履歴を複製して分岐。",
  "turn.started": "ターン開始。",
  "turn.ended": "ターン終了。",
  "model.requested": "モデル呼び出しの直前。",
  "model.delta": "ストリーミング差分。既定では購読されない。",
  "model.completed": "モデルストリーム完了。",
  "model.failed": "モデル呼び出しの失敗。",
  "tool.requested": "ツール呼び出しの要求。引数は tool.before フックで扱う。",
  "tool.started": "ツール実行開始。async ではジョブ ID を持つ。",
  "tool.completed": "ツール呼び出しがモデルに返るまで完了。async では jobId を返した時点で発行。",
  "tool.failed": "ツール呼び出し自体の失敗。ジョブの失敗は job.failed。",
  "tool.cancelled": "ツール呼び出しがモデルに返る前のキャンセル。ジョブは job.cancelled。",
  "job.running": "非同期ジョブ開始。",
  "job.done": "非同期ジョブ完了。callId で元の tool_call と相関する。",
  "job.failed": "非同期ジョブ失敗。callId で元の tool_call と相関する。",
  "job.cancelled": "非同期ジョブキャンセル。by に主体を記録。",
  "job.notified": "完了通知を履歴へ追記した。",
  "message.appended": "履歴へメッセージを追記した。本文は messageId で参照する。",
  "history.rewritten": "履歴が書き換えられた。",
  "prompt.assembled": "システムプロンプトを結合した。",
  "compaction.requested": "compaction の実行要求。",
  "compaction.completed": "compaction 完了。",
  "agent.spawned": "サブエージェントを開始した。",
  "agent.message": "サブエージェントへのメッセージ。本文は messageId で参照する。",
  "agent.cancelled": "サブエージェントをキャンセルした。",
  "module.loaded": "モジュールのロード完了。",
  "module.failed": "モジュールの失敗。",
  "module.disabled": "モジュールを無効化した。",
  "permission.requested": "権限の承認要求。",
  "permission.granted": "権限を付与した。",
  "permission.denied": "権限を拒否した。",
  "permission.violation": "権限違反を検出した。",
  "core.started": "コア起動完了。",
  "core.stopping": "コア停止開始。",
} satisfies Record<CoreEventType, string>;

/**
 * 共通イベントエンベロープ。
 * id は `evt_<bootId>_<seq>`。bootId は起動ごとにランダムな短い文字列。
 * seq はコアだけが採番する。ペイロードに秘密情報やプロンプト本文を載せない。
 */
export type EventEnvelope<TType extends string = string, TPayload = unknown> = {
  id: string;
  seq: number;
  ts: number;
  type: TType;
  /** "core" またはモジュール名。 */
  source: string;
  sessionId?: string;
  payload: TPayload;
};

/** 型付きコアイベント。 */
export type CoreEvent<TType extends CoreEventType = CoreEventType> = EventEnvelope<
  TType,
  EventPayload<TType>
>;

/** 起動ごとの bootId と seq からイベント ID を作る。 */
export function makeEventId(bootId: string, seq: number): string {
  if (bootId.length === 0) throw new Error("bootId must not be empty");
  if (!Number.isInteger(seq) || seq < 0) throw new Error("seq must be a non-negative integer");
  return `evt_${bootId}_${seq}`;
}
