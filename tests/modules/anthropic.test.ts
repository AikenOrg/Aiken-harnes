import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/protocol/messages.ts";
import type { ModelInfo, ModelRequest } from "../../src/protocol/provider.ts";
import type { PromptSegment } from "../../src/protocol/prompt.ts";
import {
  AnthropicProvider,
  type AnthropicConfig,
  type AnthropicRequestBody,
  toAnthropicRequest,
} from "../../src/modules/provider-anthropic/index.ts";

function config(logRaw = false): AnthropicConfig {
  return {
    model: "anthropic/claude-sonnet-4-5",
    models: [{ id: "anthropic/claude-sonnet-4-5", contextWindow: 200_000, maxOutput: 8_192 }],
    apiKeySecret: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1/messages",
    maxTokens: 1_024,
    promptCaching: true,
    logRaw,
    authStyle: "x-api-key",
    reasoningStyle: "anthropic_thinking",
    echoReasoning: "always",
  };
}

const model = {
  id: "anthropic/claude-sonnet-4-5",
  provider: "provider-anthropic",
  contextWindow: 200_000,
  maxOutput: 8_192,
};

const system: PromptSegment[] = [
  { id: "config.system", source: "config", stability: "static", priority: 1000, content: "config" },
  { id: "core.rules", source: "core", stability: "static", priority: 900, content: "core" },
  { id: "mod.static", source: "mod", stability: "static", priority: 100, content: "module" },
  { id: "session", source: "mod", stability: "session", priority: 1, content: "session" },
];

function request(messages: Message[] = []): ModelRequest {
  return {
    model: "anthropic/claude-sonnet-4-5",
    system,
    messages,
    tools: [
      {
        name: "read",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    params: { temperature: 0.2, maxTokens: 1_024 },
  };
}

describe("Anthropic provider", () => {
  test("converts system, tool calls, tool results, and notifications", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        blocks: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "toolu_1", name: "read", args: { path: "README.md" } },
        ],
      },
      {
        id: "m2",
        role: "tool",
        createdAt: 2,
        blocks: [
          { type: "tool_result", toolCallId: "toolu_1", name: "read", content: "# hi" },
        ],
      },
      {
        id: "m3",
        role: "notification",
        createdAt: 3,
        blocks: [
          {
            type: "notification",
            entries: [{ id: "job_1", status: "done", summary: "ok", size: 2 }],
          },
        ],
      },
    ];

    const body: AnthropicRequestBody = toAnthropicRequest(request(messages), config(), model);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(1_024);
    expect(body.temperature).toBe(0.2);
    expect(body.system.map((block) => block.text)).toEqual(["config", "core", "module", "session"]);
    expect(body.system[2]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[3]?.cache_control).toBeUndefined();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("assistant");
    expect(body.messages[0]?.content[1]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "read",
      input: { path: "README.md" },
    });
    expect(body.messages[1]?.role).toBe("user");
    expect(body.messages[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "# hi",
    });
    expect(body.messages[1]?.content[1]).toMatchObject({ type: "text" });
    expect(body.tools?.[0]?.input_schema).toMatchObject({ type: "object" });
  });

  test("streams text, assembles tool_call JSON, and reports cacheRead", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40}}}\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n',
    ].join("");

    let capturedHeaders: Record<string, string> = {};
    const logs: Array<{ message: string; meta: unknown }> = [];
    const provider = new AnthropicProvider({
      config: config(true),
      getApiKey: () => "secret-key",
      log: (message, meta) => logs.push({ message, meta }),
      fetch: async (_input, init) => {
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    const events = [];
    for await (const event of provider.stream(request([]), new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "usage", input: 100, output: 0, cacheRead: 40 },
      { type: "text", delta: "Hi" },
      { type: "tool_call", id: "toolu_1", name: "read", args: { path: "a.txt" } },
      { type: "usage", input: 0, output: 20 },
      { type: "stop", reason: "tool_use" },
    ]);
    expect(capturedHeaders["x-api-key"]).toBe("secret-key");
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain("anthropic request");
    expect(serializedLogs).not.toContain("secret-key");
  });

  test("maps context length errors to context_overflow", async () => {
    const provider = new AnthropicProvider({
      config: config(),
      getApiKey: () => "secret-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", message: "prompt is too long: maximum context length exceeded" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    let caught: unknown;
    try {
      for await (const _event of provider.stream(request([]), new AbortController().signal)) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("context_overflow");
  });
});

describe("Anthropic reasoning", () => {
  const reasoningModel: ModelInfo = {
    ...model,
    reasoning: { supported: true, efforts: ["low", "medium", "high", "max"], budget: true },
  };

  test("sends thinking budget and replays signed thinking before tool_use", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        blocks: [
          { type: "reasoning", text: "signed thought", opaque: { kind: "signature", value: "sig" } },
          { type: "text", text: "calling" },
          { type: "tool_call", id: "call_1", name: "read", args: { path: "a" } },
        ],
      },
    ];
    const req = request(messages);
    req.params = { temperature: 0.3, reasoning: { effort: "high", budgetTokens: 9_000 } };
    const body = toAnthropicRequest(
      req,
      { ...config(), maxTokens: 8_192, echoReasoning: "always" },
      reasoningModel,
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4_096 });
    expect(body.temperature).toBeUndefined();
    const content = body.messages[0]?.content ?? [];
    expect(content[0]).toEqual({ type: "thinking", thinking: "signed thought", signature: "sig" });
    expect(content[1]).toEqual({ type: "text", text: "calling" });
    expect(content[2]).toMatchObject({ type: "tool_use", name: "read" });
  });

  test("drops unsigned thinking and replays redacted_thinking", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        blocks: [
          { type: "reasoning", text: "unsigned" },
          { type: "reasoning", text: "", opaque: { kind: "redacted", data: "encrypted" } },
          { type: "tool_call", id: "call_1", name: "read", args: {} },
        ],
      },
    ];
    const req = request(messages);
    req.params = { reasoning: { effort: "high" } };
    const body = toAnthropicRequest(req, { ...config(), maxTokens: 8_192 }, reasoningModel);
    const content = body.messages[0]?.content ?? [];
    expect(content).toEqual([
      { type: "redacted_thinking", data: "encrypted" },
      { type: "tool_use", id: "call_1", name: "read", input: {} },
    ]);
  });

  test("streams thinking, signature, text, and reasoning tokens", async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}\n',
      'data: {"type":"content_block_stop","index":0}\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":"answer"}}\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n',
      'data: {"type":"content_block_stop","index":1}\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7,"output_tokens_details":{"thinking_tokens":4}}}\n',
      'data: {"type":"message_stop"}\n',
    ].join("");
    const provider = new AnthropicProvider({
      config: { ...config(), maxTokens: 8_192 },
      getApiKey: () => "secret",
      fetch: async () => new Response(sse, { status: 200 }),
    });
    const events = [];
    for await (const event of provider.stream(request([]), new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "usage", input: 20, output: 0 },
      { type: "reasoning", delta: "plan" },
      { type: "reasoning_end", opaque: { kind: "signature", value: "sig-1" } },
      { type: "text", delta: "answer" },
      { type: "text", delta: "answer" },
      { type: "usage", input: 0, output: 7, reasoning: 4 },
      { type: "stop", reason: "end" },
    ]);
  });

  test("streams redacted thinking as opaque only", async () => {
    const sse = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"enc"}}\n',
      'data: {"type":"content_block_stop","index":0}\n',
      'data: {"type":"message_stop"}\n',
    ].join("");
    const provider = new AnthropicProvider({
      config: { ...config(), maxTokens: 8_192 },
      getApiKey: () => "secret",
      fetch: async () => new Response(sse, { status: 200 }),
    });
    const events = [];
    for await (const event of provider.stream(request([]), new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "reasoning_end", opaque: { kind: "redacted", data: "enc" } },
      { type: "stop", reason: "end" },
    ]);
  });

  test("supports bearer auth for the OpenCode Go Anthropic endpoint", async () => {
    let headers: Record<string, string> = {};
    const provider = new AnthropicProvider({
      config: { ...config(), authStyle: "bearer", maxTokens: 8_192 },
      getApiKey: () => "secret-key",
      fetch: async (_input, init) => {
        headers = init.headers as Record<string, string>;
        return new Response('data: {"type":"message_stop"}\n', { status: 200 });
      },
    });
    for await (const _event of provider.stream(request([]), new AbortController().signal)) {
      // drain
    }
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});
