import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/protocol/messages.ts";
import type { ModelInfo, ModelRequest } from "../../src/protocol/provider.ts";
import type { PromptSegment } from "../../src/protocol/prompt.ts";
import {
  OpenCodeGoProvider,
  type OpenCodeGoConfig,
  type OpenCodeGoRequestBody,
  openCodeGoConfigSchema,
  toOpenCodeGoRequest,
} from "../../src/modules/provider-opencode-go/index.ts";

const model = {
  id: "opencode-go/glm-5.3-flash",
  provider: "provider-opencode-go",
  contextWindow: 1_000_000,
  maxOutput: 131_072,
};

const system: PromptSegment[] = [
  { id: "config.system", source: "config", stability: "static", priority: 1000, content: "config" },
  { id: "core.rules", source: "core", stability: "static", priority: 900, content: "core" },
  { id: "session", source: "mod", stability: "session", priority: 1, content: "session" },
];

function config(overrides: Record<string, unknown> = {}): OpenCodeGoConfig {
  return openCodeGoConfigSchema.parse({
    model: "opencode-go/glm-5.3-flash",
    models: [
      {
        id: "opencode-go/glm-5.3-flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1_000_000,
        maxOutput: 131_072,
      },
    ],
    maxTokens: 4_096,
    logRaw: false,
    ...overrides,
  });
}

function request(messages: Message[] = []): ModelRequest {
  return {
    model: "opencode-go/glm-5.3-flash",
    system,
    messages,
    tools: [
      {
        name: "read",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    params: { temperature: 0.2 },
    sessionId: "ses_test_1",
  };
}

describe("OpenCode Go provider", () => {
  test("converts system, tool calls, tool results, and notifications", () => {
    const messages: Message[] = [
      {
        id: "m1",
        role: "assistant",
        createdAt: 1,
        blocks: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "call_1", name: "read", args: { path: "README.md" } },
        ],
      },
      {
        id: "m2",
        role: "tool",
        createdAt: 2,
        blocks: [{ type: "tool_result", toolCallId: "call_1", name: "read", content: "# hi" }],
      },
      {
        id: "m3",
        role: "notification",
        createdAt: 3,
        blocks: [
          { type: "notification", entries: [{ id: "job_1", status: "done", summary: "ok", size: 2 }] },
        ],
      },
    ];

    const body: OpenCodeGoRequestBody = toOpenCodeGoRequest(request(messages), config(), model);
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.max_tokens).toBe(4_096);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: "system", content: "config\n\ncore\n\nsession" });
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      content: "calling",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "# hi" });
    expect(body.messages[3]).toMatchObject({ role: "user" });
    expect((body.messages[3] as { content: string }).content).toContain("job notifications");
    expect(body.tools?.[0]).toMatchObject({ type: "function", function: { name: "read" } });
  });

  test("converts image blocks into image_url content parts", () => {
    const imageModel: ModelInfo = {
      ...model,
      supportsImages: true,
      imageMediaTypes: ["image/png", "image/jpeg"],
    };
    const messages: Message[] = [
      {
        id: "m1",
        role: "user",
        createdAt: 1,
        blocks: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "YWJj", name: "a.png" },
        ],
      },
    ];
    const body = toOpenCodeGoRequest(request(messages), config(), imageModel);
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
      ],
    });
  });

  test("streams text, assembles tool calls, sends session headers, and reports cacheRead", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":40}}}\n',
      "data: [DONE]\n",
    ].join("");

    let headers: Record<string, string> = {};
    const logs: Array<{ message: string; meta: unknown }> = [];
    const provider = new OpenCodeGoProvider({
      config: config({ logRaw: true }),
      getApiKey: () => "secret-key",
      log: (message, meta) => logs.push({ message, meta }),
      fetch: async (_input, init) => {
        headers = init.headers as Record<string, string>;
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    const events = [];
    for await (const event of provider.stream(request([]), new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "text", delta: "Hi" },
      { type: "tool_call", id: "call_1", name: "read", args: { path: "a.txt" } },
      { type: "usage", input: 100, output: 20, cacheRead: 40 },
      { type: "stop", reason: "tool_use" },
    ]);
    expect(headers.authorization).toBe("Bearer secret-key");
    expect(headers["x-opencode-session"]).toBe("ses_test_1");
    expect(headers["user-agent"]).toBe("next-harness/0.1.0");
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("opencode-go request");
    expect(serialized).not.toContain("secret-key");
  });

  test("maps context length errors to context_overflow", async () => {
    const provider = new OpenCodeGoProvider({
      config: config(),
      getApiKey: () => "secret-key",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: "prompt is too long for this model's maximum context length" } }),
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

describe("OpenCode Go reasoning", () => {
  const reasoningModel: ModelInfo = {
    ...model,
    reasoning: { supported: true, efforts: ["low", "high", "max"] },
  };

  test("builds effort/thinking/budget request shapes and applies effortMap", () => {
    const base = request();
    base.params = { temperature: 0.2, reasoning: { effort: "medium", budgetTokens: 6_000 } };
    const effortBody = toOpenCodeGoRequest(
      base,
      config({ reasoningStyle: "effort_param", effortMap: { medium: "high" } }),
      reasoningModel,
    );
    expect(effortBody.reasoning_effort).toBe("high");
    expect(effortBody.thinking).toBeUndefined();
    expect(effortBody.temperature).toBe(0.2);

    const thinkingBody = toOpenCodeGoRequest(
      base,
      config({ reasoningStyle: "thinking_object" }),
      reasoningModel,
    );
    expect(thinkingBody.thinking).toEqual({ type: "enabled" });
    expect(thinkingBody.temperature).toBeUndefined();

    const anthropicBody = toOpenCodeGoRequest(
      base,
      config({ reasoningStyle: "anthropic_thinking" }),
      reasoningModel,
    );
    expect(anthropicBody.thinking).toEqual({ type: "enabled", budget_tokens: 2_048 });
  });

  test("echoes reasoning_content for tool turns when configured", () => {
    const message: Message = {
      id: "m1",
      role: "assistant",
      createdAt: 1,
      blocks: [
        { type: "reasoning", text: "thought" },
        { type: "tool_call", id: "call_1", name: "read", args: { path: "a" } },
      ],
    };
    const body = toOpenCodeGoRequest(
      request([message]),
      config({ echoReasoning: "always" }),
      reasoningModel,
    );
    expect(body.messages[1]).toMatchObject({ role: "assistant", reasoning_content: "thought" });

    const toolOnly = toOpenCodeGoRequest(
      request([message]),
      config({ echoReasoning: "tool_turns" }),
      reasoningModel,
    );
    expect(toolOnly.messages[1]).toMatchObject({ reasoning_content: "thought" });
  });

  test("automatically replays reasoning_content for DeepSeek models", () => {
    const deepseekModel: ModelInfo = {
      id: "opencode-go/deepseek-v4.1-flash",
      provider: "provider-opencode-go",
      contextWindow: 1_000_000,
      maxOutput: 131_072,
      reasoning: { supported: true, efforts: ["low", "high", "max"], toggle: true },
    };
    const withReasoning: Message = {
      id: "m1",
      role: "assistant",
      createdAt: 1,
      blocks: [
        { type: "reasoning", text: "deep thought" },
        { type: "tool_call", id: "call_1", name: "read", args: {} },
      ],
    };
    const withoutReasoning: Message = {
      id: "m2",
      role: "assistant",
      createdAt: 2,
      blocks: [{ type: "tool_call", id: "call_2", name: "read", args: {} }],
    };
    const body = toOpenCodeGoRequest(
      request([withReasoning, withoutReasoning]),
      config({ echoReasoning: "never" }),
      deepseekModel,
    );
    expect(body.messages[1]).toMatchObject({ reasoning_content: "deep thought" });
    expect(body.messages[2]).toMatchObject({ reasoning_content: "" });
  });

  test("streams reasoning and reasoning tokens separately from text", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":8,"completion_tokens_details":{"reasoning_tokens":5}}}\n',
      "data: [DONE]\n",
    ].join("");
    const provider = new OpenCodeGoProvider({
      config: config(),
      getApiKey: () => "secret",
      fetch: async () => new Response(sse, { status: 200 }),
    });
    const events = [];
    for await (const event of provider.stream(request([]), new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "reasoning", delta: "think" },
      { type: "text", delta: "answer" },
      { type: "usage", input: 10, output: 8, reasoning: 5 },
      { type: "reasoning_end" },
      { type: "stop", reason: "end" },
    ]);
  });

  test("retries a reasoning-related 400 once without the parameter and remembers the model", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const logs: string[] = [];
    const provider = new OpenCodeGoProvider({
      config: config({ reasoningRetry: true }),
      getApiKey: () => "secret",
      log: (message) => logs.push(message),
      fetch: async (_input, init) => {
        calls += 1;
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (calls === 1) {
          return new Response(
            JSON.stringify({ error: { message: "invalid reasoning_effort", type: "invalid_request_error" } }),
            { status: 400 },
          );
        }
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n', {
          status: 200,
        });
      },
    });
    const reasoningRequest = request([]);
    reasoningRequest.params = { reasoning: { effort: "high" } };
    const first = [];
    for await (const event of provider.stream(reasoningRequest, new AbortController().signal)) first.push(event);
    expect(first[0]).toMatchObject({ type: "reasoning_ignored" });
    expect(first.some((event) => event.type === "text")).toBe(true);
    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
    expect(logs.some((message) => message.includes("reasoning parameter rejected"))).toBe(true);

    const second = [];
    for await (const event of provider.stream(reasoningRequest, new AbortController().signal)) second.push(event);
    expect(second[0]).toMatchObject({ type: "reasoning_ignored" });
    expect(calls).toBe(3);
    expect(bodies[2]?.reasoning_effort).toBeUndefined();
  });

  test("retries transient 429/5xx responses and network errors", async () => {
    let calls = 0;
    const provider = new OpenCodeGoProvider({
      config: config({ maxRetries: 2, retryBaseDelayMs: 0 }),
      getApiKey: () => "secret",
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("rate limited", { status: 429 });
        if (calls === 2) throw new Error("connection reset");
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n', {
          status: 200,
        });
      },
    });
    const events = [];
    for await (const event of provider.stream(request([]), new AbortController().signal)) events.push(event);
    expect(calls).toBe(3);
    expect(events.some((event) => event.type === "text")).toBe(true);
  });

  test("gives up after maxRetries for persistent 5xx", async () => {
    let calls = 0;
    const provider = new OpenCodeGoProvider({
      config: config({ maxRetries: 1, retryBaseDelayMs: 0 }),
      getApiKey: () => "secret",
      fetch: async () => {
        calls += 1;
        return new Response("server error", { status: 503 });
      },
    });
    let caught: unknown;
    try {
      for await (const _event of provider.stream(request([]), new AbortController().signal)) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(2);
    expect((caught as { code?: string }).code).toBe("api_error");
  });

  test("does not retry an unrelated 400", async () => {
    let calls = 0;
    const provider = new OpenCodeGoProvider({
      config: config(),
      getApiKey: () => "secret",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "bad tool schema" } }), { status: 400 });
      },
    });
    const reasoningRequest = request([]);
    reasoningRequest.params = { reasoning: { effort: "high" } };
    let caught: unknown;
    try {
      for await (const _event of provider.stream(reasoningRequest, new AbortController().signal)) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(1);
    expect((caught as { code?: string }).code).toBe("api_error");
  });
});
