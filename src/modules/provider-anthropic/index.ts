import { z } from "zod";
import type { ModuleExports } from "../../protocol/ctx.ts";
import type { StopReason } from "../../protocol/common.ts";
import type { Message, ToolCallBlock, ToolResultBlock } from "../../protocol/messages.ts";
import type { ModelEvent, ModelInfo, ModelRequest, Provider } from "../../protocol/provider.ts";
import type { PromptSegment } from "../../protocol/prompt.ts";
import type { ToolSpec } from "../../protocol/tools.ts";

const DEFAULT_MODELS = [
  { id: "anthropic/claude-sonnet-4-5", contextWindow: 200_000, maxOutput: 8_192 },
  { id: "anthropic/claude-haiku-4-5", contextWindow: 200_000, maxOutput: 8_192 },
];

const configSchema = z.object({
  model: z.string().default("anthropic/claude-sonnet-4-5"),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        contextWindow: z.number().int().positive(),
        maxOutput: z.number().int().positive().optional(),
      }),
    )
    .default(DEFAULT_MODELS),
  apiKeySecret: z.string().default("ANTHROPIC_API_KEY"),
  baseUrl: z.string().url().default("https://api.anthropic.com/v1/messages"),
  maxTokens: z.number().int().positive().default(4_096),
  promptCaching: z.boolean().default(true),
  logRaw: z.boolean().default(false),
});

export type AnthropicConfig = z.infer<typeof configSchema>;

type AnthropicSystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContentBlock[] };

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  temperature?: number;
};

export class AnthropicApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AnthropicApiError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function modelApiName(modelId: string): string {
  return modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
}

function isContextOverflow(message: string): boolean {
  return /prompt is too long|context length|context window|too many tokens|maximum context/i.test(message);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function contentOfSegment(segment: PromptSegment): AnthropicSystemBlock {
  return { type: "text", text: segment.content };
}

function toolResultBlock(block: ToolResultBlock): AnthropicContentBlock {
  return {
    type: "tool_result",
    tool_use_id: block.toolCallId,
    content: block.content,
    ...(block.isError === true ? { is_error: true } : {}),
  };
}

function toolCallBlock(block: ToolCallBlock): AnthropicContentBlock {
  return { type: "tool_use", id: block.id, name: block.name, input: asObject(block.args) };
}

function notificationText(block: Extract<Message["blocks"][number], { type: "notification" }>): string {
  const entries = block.entries.map((entry) => JSON.stringify(entry)).join("\n");
  return `[job notifications]\n${entries}`;
}

function messageBlocks(message: Message): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const block of message.blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_call") {
      blocks.push(toolCallBlock(block));
    } else if (block.type === "tool_result") {
      blocks.push(toolResultBlock(block));
    } else if (block.type === "notification") {
      blocks.push({ type: "text", text: notificationText(block) });
    }
  }
  return blocks;
}

/** コアの ModelRequest を Anthropic Messages API の body へ変換する。 */
export function toAnthropicRequest(
  request: ModelRequest,
  config: AnthropicConfig,
  model: ModelInfo,
): AnthropicRequestBody {
  const lastStaticIndex = request.system.reduce(
    (last, segment, index) => (segment.stability === "static" ? index : last),
    -1,
  );
  const system: AnthropicSystemBlock[] = request.system.map((segment, index) => {
    const block = contentOfSegment(segment);
    if (config.promptCaching && index === lastStaticIndex) {
      block.cache_control = { type: "ephemeral" };
    }
    return block;
  });

  const messages: AnthropicMessage[] = [];
  for (const message of request.messages) {
    const blocks = messageBlocks(message);
    if (blocks.length === 0) continue;
    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous && previous.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }

  const maxTokens = Math.min(
    config.maxTokens,
    model.maxOutput ?? config.maxTokens,
  );
  const body: AnthropicRequestBody = {
    model: modelApiName(request.model),
    max_tokens: maxTokens,
    system,
    messages,
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool: ToolSpec) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
  if (request.params?.temperature !== undefined) body.temperature = request.params.temperature;
  return body;
}

type StreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
};

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
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
        if (data.length === 0 || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as StreamEvent;
        } catch (error) {
          throw new AnthropicApiError(
            "invalid_stream",
            `invalid Anthropic stream event: ${error instanceof Error ? error.message : String(error)}`,
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

function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === undefined) return "end";
  return "end";
}

function errorFromEvent(event: StreamEvent): AnthropicApiError {
  const message = event.error?.message ?? "Anthropic stream error";
  return new AnthropicApiError(isContextOverflow(message) ? "context_overflow" : "api_error", message);
}

function errorFromResponse(status: number, text: string): AnthropicApiError {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (typeof parsed.error?.message === "string") message = parsed.error.message;
  } catch {
    // keep raw text
  }
  if (status === 401 || status === 403) return new AnthropicApiError("auth_failed", message, status);
  if (status === 429) return new AnthropicApiError("rate_limited", message, status);
  if (status === 400 && isContextOverflow(message)) {
    return new AnthropicApiError("context_overflow", message, status);
  }
  return new AnthropicApiError("api_error", `${status}: ${message}`, status);
}

export type AnthropicFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AnthropicProviderOptions = {
  config: AnthropicConfig;
  fetch: AnthropicFetch;
  getApiKey: () => string;
  log?: (message: string, meta?: unknown) => void;
};

/** Anthropic Messages API のストリーミングプロバイダー。 */
export class AnthropicProvider implements Provider {
  #config: AnthropicConfig;
  #fetch: AnthropicFetch;
  #getApiKey: () => string;
  #log: (message: string, meta?: unknown) => void;

  constructor(options: AnthropicProviderOptions) {
    this.#config = options.config;
    this.#fetch = options.fetch;
    this.#getApiKey = options.getApiKey;
    this.#log = options.log ?? (() => {});
  }

  models(): ModelInfo[] {
    return this.#config.models.map((model) => ({
      id: model.id,
      provider: "provider-anthropic",
      contextWindow: model.contextWindow,
      ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
      supportsTools: true,
      supportsCache: true,
    }));
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const model = this.models().find((candidate) => candidate.id === request.model);
    if (!model) throw new AnthropicApiError("unknown_model", `unknown model: ${request.model}`);
    const apiKey = this.#getApiKey();
    const body = toAnthropicRequest(request, this.#config, model);

    if (this.#config.logRaw) this.#log("anthropic request", { model: body.model, body });
    const response = await this.#fetch(this.#config.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      if (this.#config.logRaw) this.#log("anthropic error response", { status: response.status, text });
      throw errorFromResponse(response.status, text);
    }
    if (!response.body) throw new AnthropicApiError("invalid_stream", "Anthropic response has no body");
    if (this.#config.logRaw) this.#log("anthropic response", { status: response.status });

    const toolJson = new Map<number, { id: string; name: string; json: string }>();
    let stop: StopReason | undefined;

    for await (const event of sseEvents(response.body, signal)) {
      if (signal.aborted) return;
      if (this.#config.logRaw) this.#log("anthropic stream event", event);

      if (event.type === "error") throw errorFromEvent(event);

      if (event.type === "message_start") {
        yield {
          type: "usage",
          input: event.message?.usage?.input_tokens ?? 0,
          output: 0,
          ...(event.message?.usage?.cache_read_input_tokens !== undefined
            ? { cacheRead: event.message.usage.cache_read_input_tokens }
            : {}),
        };
      } else if (event.type === "content_block_start") {
        if (event.content_block?.type === "text" && event.content_block.text) {
          yield { type: "text", delta: event.content_block.text };
        } else if (event.content_block?.type === "tool_use") {
          toolJson.set(event.index ?? 0, {
            id: event.content_block.id ?? `tool_${event.index ?? 0}`,
            name: event.content_block.name ?? "unknown",
            json: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text", delta: event.delta.text };
        } else if (event.delta?.type === "input_json_delta") {
          const index = event.index ?? 0;
          const current = toolJson.get(index);
          if (current) current.json += event.delta.partial_json ?? "";
        }
      } else if (event.type === "content_block_stop") {
        const index = event.index ?? 0;
        const current = toolJson.get(index);
        if (current) {
          toolJson.delete(index);
          let args: unknown = {};
          if (current.json.trim().length > 0) {
            try {
              args = JSON.parse(current.json);
            } catch {
              throw new AnthropicApiError("invalid_tool_call", `invalid tool args: ${current.json}`);
            }
          }
          yield { type: "tool_call", id: current.id, name: current.name, args };
        }
      } else if (event.type === "message_delta") {
        stop = mapStopReason(event.delta?.stop_reason);
        yield { type: "usage", input: 0, output: event.usage?.output_tokens ?? 0 };
      } else if (event.type === "message_stop") {
        yield { type: "stop", reason: stop ?? "end" };
        return;
      }
    }

    if (signal.aborted) return;
    yield { type: "stop", reason: stop ?? "error" };
  }
}

const module: ModuleExports = {
  init(ctx, rawConfig) {
    const config = configSchema.parse(rawConfig);
    const provider = new AnthropicProvider({
      config,
      fetch: (input, init) => ctx.net.fetch(input, init),
      getApiKey: () => ctx.secrets.get(config.apiKeySecret),
      log: (message, meta) => ctx.log.debug(message, meta),
    });
    ctx.providers.register(provider);
  },
};

export { configSchema as anthropicConfigSchema };
export default module;
export const init = module.init;
