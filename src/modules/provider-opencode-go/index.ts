import { readFileSync } from "node:fs";
import { z } from "zod";
import type { StopReason } from "../../protocol/common.ts";
import type { ModuleExports } from "../../protocol/ctx.ts";
import type { Message, ToolCallBlock, ToolResultBlock } from "../../protocol/messages.ts";
import type { ModelEvent, ModelInfo, ModelRequest, Provider } from "../../protocol/provider.ts";
import type { ReasoningCapability, ReasoningParams } from "../../protocol/reasoning.ts";
import type { ToolSpec } from "../../protocol/tools.ts";

type ModelEntry = {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsCache: boolean;
  reasoning?: ReasoningCapability;
};

const DEFAULT_MODELS = JSON.parse(
  readFileSync(new URL("./models.json", import.meta.url), "utf8"),
) as ModelEntry[];

const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

const configSchema = z.object({
  model: z.string().default(DEFAULT_MODEL),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        contextWindow: z.number().int().positive(),
        maxOutput: z.number().int().positive().optional(),
        supportsTools: z.boolean().optional(),
        supportsCache: z.boolean().optional(),
        reasoning: z
          .object({
            supported: z.boolean(),
            efforts: z.array(z.enum(["off", "low", "medium", "high", "max"])).optional(),
            toggle: z.boolean().optional(),
            budget: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  apiKeySecret: z.string().default("OPENCODE_API_KEY"),
  baseUrl: z
    .string()
    .url()
    .default("https://opencode.ai/inference/go/openai/v1/chat/completions"),
  maxTokens: z.number().int().positive().default(8_192),
  logRaw: z.boolean().default(false),
  userAgent: z.string().default("next-harness/0.1.0"),
  /** reasoning の送信形式。既定は最上位の reasoning_effort。 */
  reasoningStyle: z
    .enum(["effort_param", "thinking_object", "both", "anthropic_thinking", "none"])
    .default("effort_param"),
  /** 共通 effort をモデル固有の値へ変換する。 */
  effortMap: z.record(z.string(), z.string()).default({}),
  /** 履歴の reasoning を assistant メッセージへ戻す条件。 */
  echoReasoning: z.enum(["never", "tool_turns", "always"]).default("never"),
  /** OpenAI 互換 assistant の reasoning フィールド名。 */
  reasoningField: z.string().default("reasoning_content"),
  /** reasoning 指定が原因の 400 のとき、指定を外して 1 回だけ再試行する。 */
  reasoningRetry: z.boolean().default(true),
});

export type OpenCodeGoConfig = z.infer<typeof configSchema>;

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenCodeGoRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  stream: true;
  stream_options: { include_usage: true };
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: string;
  thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };
};

export class OpenCodeGoError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "OpenCodeGoError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function normalizeModelId(id: string): string {
  return id.startsWith("opencode-go/") ? id : `opencode-go/${id}`;
}

function modelApiName(id: string): string {
  return id.startsWith("opencode-go/") ? id.slice("opencode-go/".length) : id;
}

function isContextOverflow(message: string): boolean {
  return /prompt is too long|context length|context window|too many tokens|maximum context|reduce the length/i.test(message);
}

function notificationText(block: Extract<Message["blocks"][number], { type: "notification" }>): string {
  return `[job notifications]\n${block.entries.map((entry) => JSON.stringify(entry)).join("\n")}`;
}

function fitThinkingBudget(budget: number | undefined, maxTokens: number): number {
  const requested = budget ?? Math.max(1, Math.floor(maxTokens / 2));
  return Math.max(1, Math.min(requested, Math.floor(maxTokens / 2)));
}

function nearestEffort(
  effort: string,
  capability: ReasoningCapability | undefined,
  map: Record<string, string>,
): string {
  // 明示的な変換はユーザーの意図を優先する。
  const explicit = map[effort];
  if (explicit !== undefined) return explicit;
  const allowed = capability?.efforts;
  if (!allowed || allowed.length === 0 || allowed.includes(effort as never)) return effort;
  const order = ["low", "medium", "high", "max"];
  const wanted = Math.max(0, order.indexOf(effort));
  const candidates = allowed
    .map((value) => ({ value, index: order.indexOf(value) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => Math.abs(a.index - wanted) - Math.abs(b.index - wanted));
  return candidates[0]?.value ?? effort;
}

function applyReasoning(
  body: OpenCodeGoRequestBody,
  reasoning: ReasoningParams | undefined,
  config: OpenCodeGoConfig,
  model: ModelInfo,
  maxTokens: number,
): boolean {
  if (reasoning === undefined) return false;
  if (config.reasoningStyle === "none") return false;
  if (model.reasoning?.supported === false) return false;
  const off = reasoning.effort === "off";
  const effort = off ? "none" : nearestEffort(reasoning.effort ?? "medium", model.reasoning, config.effortMap);
  const budget = fitThinkingBudget(reasoning.budgetTokens, maxTokens);
  if (config.reasoningStyle === "effort_param" || config.reasoningStyle === "both") {
    body.reasoning_effort = effort;
  }
  if (config.reasoningStyle === "thinking_object" || config.reasoningStyle === "both") {
    body.thinking = off ? { type: "disabled" } : { type: "enabled" };
  }
  if (config.reasoningStyle === "anthropic_thinking") {
    body.thinking = off
      ? { type: "disabled" }
      : { type: "enabled", budget_tokens: budget };
  }
  if (!off && body.thinking?.type === "enabled") delete body.temperature;
  return true;
}

function replayedReasoning(message: Message, config: OpenCodeGoConfig, hasToolCalls: boolean): string | undefined {
  if (config.echoReasoning === "never") return undefined;
  if (config.echoReasoning === "tool_turns" && !hasToolCalls) return undefined;
  const text = message.blocks
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

function toolCallArgs(block: ToolCallBlock): OpenAIToolCall {
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: JSON.stringify(block.args ?? {}) },
  };
}

/** コアの ModelRequest を OpenAI 互換 chat completions の body に変換する。 */
export function toOpenCodeGoRequest(
  request: ModelRequest,
  config: OpenCodeGoConfig,
  model: ModelInfo,
): OpenCodeGoRequestBody {
  const system = request.system.map((segment) => segment.content).join("\n\n");
  const messages: OpenAIMessage[] = [];
  if (system.trim().length > 0) messages.push({ role: "system", content: system });

  for (const message of request.messages) {
    if (message.role === "assistant") {
      const text = message.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = message.blocks
        .filter((block): block is ToolCallBlock => block.type === "tool_call")
        .map(toolCallArgs);
      const entry: OpenAIMessage = {
        role: "assistant",
        content: text.length > 0 ? text : null,
      };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      const replayed = replayedReasoning(message, config, toolCalls.length > 0);
      if (replayed !== undefined) {
        (entry as unknown as Record<string, unknown>)[config.reasoningField] = replayed;
      }
      messages.push(entry);
      continue;
    }

    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type !== "tool_result") continue;
        const result = block as ToolResultBlock;
        const content = result.isError === true ? `[error] ${result.content}` : result.content;
        messages.push({ role: "tool", tool_call_id: result.toolCallId, content });
      }
      continue;
    }

    const textParts: string[] = [];
    for (const block of message.blocks) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "notification") textParts.push(notificationText(block));
    }
    if (textParts.length > 0) messages.push({ role: "user", content: textParts.join("\n") });
  }

  const maxTokens = Math.min(config.maxTokens, model.maxOutput ?? config.maxTokens);
  const body: OpenCodeGoRequestBody = {
    model: modelApiName(request.model),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool: ToolSpec) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  if (request.params?.temperature !== undefined) body.temperature = request.params.temperature;
  applyReasoning(body, request.params?.reasoning, config, model, maxTokens);
  return body;
}

type ChoiceDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type StreamChunk = {
  choices?: Array<{ delta?: ChoiceDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cache_read_input_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string; code?: string };
};

async function* sseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as StreamChunk;
        } catch (error) {
          throw new OpenCodeGoError(
            "invalid_stream",
            `invalid OpenCode Go stream event: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    reader.releaseLock();
  }
}

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "error";
  return "end";
}

function errorFromResponse(status: number, text: string): OpenCodeGoError {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // keep raw
  }
  if (status === 401 || status === 403) return new OpenCodeGoError("auth_failed", message, status);
  if (status === 429) return new OpenCodeGoError("rate_limited", message, status);
  if (status === 400 && isContextOverflow(message)) {
    return new OpenCodeGoError("context_overflow", message, status);
  }
  return new OpenCodeGoError("api_error", `${status}: ${message}`, status);
}

export type OpenCodeGoFetch = (input: string, init: RequestInit) => Promise<Response>;

export type OpenCodeGoProviderOptions = {
  config: OpenCodeGoConfig;
  fetch: OpenCodeGoFetch;
  getApiKey: () => string;
  log?: (message: string, meta?: unknown) => void;
};

/** OpenCode Go の OpenAI 互換 chat completions プロバイダー。 */
export class OpenCodeGoProvider implements Provider {
  #config: OpenCodeGoConfig;
  #fetch: OpenCodeGoFetch;
  #getApiKey: () => string;
  #log: (message: string, meta?: unknown) => void;
  #fallbackSession = crypto.randomUUID();
  #models: ModelEntry[];
  #reasoningUnsupported = new Set<string>();

  constructor(options: OpenCodeGoProviderOptions) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#getApiKey = options.getApiKey;
    this.#log = options.log ?? (() => {});
    const configured = (options.config.models ?? DEFAULT_MODELS).map((model) => ({
      id: normalizeModelId(model.id),
      name: model.name ?? model.id,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput ?? 8_192,
      supportsTools: model.supportsTools ?? true,
      supportsCache: model.supportsCache ?? true,
      ...(model.reasoning !== undefined
        ? { reasoning: model.reasoning as ReasoningCapability }
        : {}),
    }));
    if (!configured.some((model) => model.id === normalizeModelId(options.config.model))) {
      configured.push({
        id: normalizeModelId(options.config.model),
        name: options.config.model,
        contextWindow: 200_000,
        maxOutput: 8_192,
        supportsTools: true,
        supportsCache: true,
      });
    }
    this.#models = configured;
  }

  models(): ModelInfo[] {
    return this.#models.map((model) => ({
      id: model.id,
      provider: "provider-opencode-go",
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      supportsTools: model.supportsTools,
      supportsCache: model.supportsCache,
      ...(model.reasoning !== undefined
        ? { reasoning: model.reasoning as ReasoningCapability }
        : {}),
    }));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const model = this.models().find((candidate) => candidate.id === request.model);
    if (!model) throw new OpenCodeGoError("unknown_model", `unknown model: ${request.model}`);
    const apiKey = this.#getApiKey();
    const body = toOpenCodeGoRequest(request, this.#config, model);
    const reasoning = request.params?.reasoning;
    if (reasoning !== undefined && this.#config.reasoningStyle === "none") {
      yield {
        type: "reasoning_ignored",
        reason: "reasoningStyle is none",
      };
    } else if (reasoning !== undefined && model.reasoning?.supported === false) {
      yield {
        type: "reasoning_ignored",
        reason: `${model.id} does not support reasoning on this API`,
      };
      this.#log(`reasoning ignored for ${model.id}`);
    }
    if (this.#reasoningUnsupported.has(model.id) && reasoning !== undefined) {
      delete body.reasoning_effort;
      delete body.thinking;
      yield {
        type: "reasoning_ignored",
        reason: `${model.id} rejected reasoning earlier in this process`,
      };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${apiKey}`,
      "user-agent": this.#config.userAgent,
      "x-opencode-session": request.sessionId ?? this.#fallbackSession,
    };

    if (this.#config.logRaw) this.#log("opencode-go request", { model: body.model, body });
    let response = await this.#fetch(this.#config.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let text = await response.text();
      const hasReasoning = body.reasoning_effort !== undefined || body.thinking !== undefined;
      const reasoningError = /reasoning_effort|invalid_reasoning|thinking[^.]*(budget|type)|budget_tokens/i.test(text);
      if (response.status === 400 && hasReasoning && this.#config.reasoningRetry && reasoningError) {
        this.#log(`reasoning parameter rejected by ${model.id}; retrying without it`);
        this.#reasoningUnsupported.add(model.id);
        delete body.reasoning_effort;
        delete body.thinking;
        yield {
          type: "reasoning_ignored",
          reason: `${model.id} rejected the reasoning parameter`,
        };
        response = await this.#fetch(this.#config.baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) text = await response.text();
      }
      if (!response.ok) {
        if (this.#config.logRaw) this.#log("opencode-go error response", { status: response.status, text });
        throw errorFromResponse(response.status, text);
      }
    }
    if (!response.body) throw new OpenCodeGoError("invalid_stream", "OpenCode Go response has no body");
    if (this.#config.logRaw) this.#log("opencode-go response", { status: response.status });

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let stop: StopReason | undefined;
    let emittedTools = false;
    let reasoningSeen = false;
    let finishReason: string | null | undefined;

    const emitToolCalls = function* (): Generator<ModelEvent> {
      if (emittedTools) return;
      emittedTools = true;
      for (const [index, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        let args: unknown = {};
        if (call.args.trim().length > 0) {
          try {
            args = JSON.parse(call.args);
          } catch {
            throw new OpenCodeGoError("invalid_tool_call", `invalid arguments for ${call.name}: ${call.args}`);
          }
        }
        yield {
          type: "tool_call",
          id: call.id || `call_${index}`,
          name: call.name || "unknown",
          args,
        };
      }
    };

    for await (const chunk of sseChunks(response.body, signal)) {
      if (signal.aborted) return;
      if (this.#config.logRaw) this.#log("opencode-go stream event", chunk);
      if (chunk.error) {
        const message = chunk.error.message ?? "OpenCode Go stream error";
        throw new OpenCodeGoError(isContextOverflow(message) ? "context_overflow" : "api_error", message);
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        const reasoningDelta =
          typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0
            ? delta.reasoning_content
            : typeof (delta as { reasoning?: unknown } | undefined)?.reasoning === "string"
              ? (delta as { reasoning: string }).reasoning
              : undefined;
        if (reasoningDelta) {
          reasoningSeen = true;
          yield { type: "reasoning", delta: reasoningDelta };
        }
        if (delta?.content) yield { type: "text", delta: delta.content };
        for (const tool of delta?.tool_calls ?? []) {
          const index = tool.index ?? 0;
          const current = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          if (tool.id) current.id = tool.id;
          if (tool.function?.name) current.name = tool.function.name;
          if (tool.function?.arguments) current.args += tool.function.arguments;
          toolCalls.set(index, current);
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          if (finishReason !== "length") yield* emitToolCalls();
        }
      }

      if (chunk.usage) {
        const cached =
          chunk.usage.prompt_tokens_details?.cached_tokens ??
          chunk.usage.cache_read_input_tokens ??
          chunk.usage.prompt_cache_hit_tokens ??
          0;
        const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        yield {
          type: "usage",
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          ...(cached > 0 ? { cacheRead: cached } : {}),
          ...(reasoningTokens > 0 ? { reasoning: reasoningTokens } : {}),
        };
      }
    }

    if (signal.aborted) return;
    if (finishReason !== "length") yield* emitToolCalls();
    if (reasoningSeen) yield { type: "reasoning_end" };
    stop = mapStopReason(finishReason);
    yield { type: "stop", reason: stop };
  }
}

const module: ModuleExports = {
  init(ctx, rawConfig) {
    const config = configSchema.parse(rawConfig);
    const provider = new OpenCodeGoProvider({
      config,
      fetch: (input, init) => ctx.net.fetch(input, init),
      getApiKey: () => ctx.secrets.get(config.apiKeySecret),
      log: (message, meta) => ctx.log.debug(message, meta),
    });
    ctx.providers.register(provider);
  },
};

export { configSchema as openCodeGoConfigSchema };
export default module;
export const init = module.init;
