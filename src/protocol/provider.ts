import type { StopReason, Usage } from "./common.ts";
import type { ReasoningCapability, ReasoningParams } from "./reasoning.ts";
import type { Message } from "./messages.ts";
import type { PromptSegment } from "./prompt.ts";
import type { ToolSpec } from "./tools.ts";

export type ModelInfo = {
  /** 一意なモデル ID。例: "openai/gpt-4.1" */
  id: string;
  /** プロバイダーのモジュール名。 */
  provider: string;
  /** 判定の分母。必須。 */
  contextWindow: number;
  maxOutput?: number;
  supportsTools?: boolean;
  supportsCache?: boolean;
  /** reasoning / thinking の能力。未指定は非対応扱い。 */
  reasoning?: ReasoningCapability;
};

export type ModelRequest = {
  model: string;
  system: PromptSegment[];
  messages: Message[];
  tools: ToolSpec[];
  /** プロバイダーがルーティングやキャッシュに使えるセッション ID。 */
  sessionId?: string;
  params?: {
    temperature?: number;
    maxTokens?: number;
    reasoning?: ReasoningParams;
  };
};

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_end"; opaque?: unknown }
  | { type: "reasoning_ignored"; reason: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | {
      type: "usage";
      input: number;
      output: number;
      cacheRead?: number;
      reasoning?: number;
    }
  | { type: "stop"; reason: StopReason };

/** モデル呼び出しモジュールのインターフェイス。 */
export interface Provider {
  models(): ModelInfo[];
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/** usage を加算する補助。 */
export function addUsage(total: Usage, next: Usage): Usage {
  const merged: Usage = {
    input: total.input + next.input,
    output: total.output + next.output,
  };
  const cacheRead = (total.cacheRead ?? 0) + (next.cacheRead ?? 0);
  if (cacheRead > 0) merged.cacheRead = cacheRead;
  const reasoning = (total.reasoning ?? 0) + (next.reasoning ?? 0);
  if (reasoning > 0) merged.reasoning = reasoning;
  return merged;
}
