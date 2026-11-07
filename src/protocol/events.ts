import type { CancelBy, StopReason, Usage } from "./common.ts";
import type { MessageRole } from "./messages.ts";
import type { PromptStability } from "./prompt.ts";
import type { ToolMode } from "./tools.ts";

/**
 * 共通イベントエンベロープ。
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

/** イベント型ごとのペイロード。docs/spec/06-events.md と 1:1 に対応する。 */
export interface EventPayloads {
  "user.message": { text: string };
  "user.cancel": { reason?: string };

  "session.created": { parentId?: string; model: string };
  "session.closed": { reason?: string };
  "session.forked": { fromSessionId: string };

  "turn.started": { turnId: string };
  "turn.ended": { turnId: string; reason: "completed" | "cancelled" | "error" };

  "model.requested": {
    model: string;
    messageCount: number;
    toolCount: number;
    promptHash: string;
  };
  "model.delta": { text: string };
  "model.completed": { stopReason: StopReason; usage?: Usage; durationMs: number };
  "model.failed": { error: string; retryable?: boolean };

  "tool.requested": {
    toolCallId: string;
    name: string;
    args: unknown;
    mode: ToolMode;
  };
  "tool.started": { toolCallId: string; name: string; jobId?: string };
  "tool.completed": {
    toolCallId: string;
    name: string;
    jobId?: string;
    size?: number;
    durationMs: number;
  };
  "tool.failed": { toolCallId: string; name: string; error: string };
  "tool.cancelled": { toolCallId: string; name: string; by: CancelBy };

  "job.running": { jobId: string; name: string; toolCallId: string };
  "job.done": { jobId: string; summary: string; size: number };
  "job.failed": { jobId: string; error: string };
  "job.cancelled": { jobId: string; by: CancelBy; reason?: string };
  "job.notified": { jobId: string };

  "message.appended": {
    messageId: string;
    role: MessageRole;
    blockTypes: string[];
    atTail: boolean;
  };
  "history.rewritten": { reason: string; beforeCount: number; afterCount: number };

  "prompt.assembled": {
    segmentIds: string[];
    stabilities: PromptStability[];
    cacheBoundary: number;
    hash: string;
  };

  "compaction.requested": { reason: string; tokenEstimate?: number };
  "compaction.completed": { beforeCount: number; afterCount: number };

  "agent.spawned": { childSessionId: string; parentSessionId: string; model: string };
  "agent.message": { from: string; to: string; text: string };
  "agent.cancelled": { sessionId: string; by: CancelBy };

  "module.loaded": {
    name: string;
    version: string;
    roles: readonly string[];
    critical: boolean;
  };
  "module.failed": { name: string; error: string };
  "module.disabled": { name: string; reason: string };

  "permission.requested": {
    module: string;
    permissions: readonly string[];
    warnings: string[];
  };
  "permission.granted": { module: string; permissions: readonly string[] };
  "permission.denied": { module: string; cap: string; reason: string };
  "permission.violation": { module: string; cap: string; reason: string };

  "core.started": { version: string; modules: string[] };
  "core.stopping": { reason: string };
}

export type CoreEventType = keyof EventPayloads;

/** 型付きコアイベント。 */
export type CoreEvent<TType extends CoreEventType = CoreEventType> = EventEnvelope<
  TType,
  EventPayloads[TType]
>;
