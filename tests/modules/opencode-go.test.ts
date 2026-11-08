import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/protocol/messages.ts";
import type { ModelRequest } from "../../src/protocol/provider.ts";
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
