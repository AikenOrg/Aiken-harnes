import type { ModuleExports } from "../../protocol/ctx.ts";
import type { ModelEvent, ModelRequest, ModelInfo, Provider } from "../../protocol/provider.ts";

class EchoProvider implements Provider {
  models(): ModelInfo[] {
    return [
      {
        id: "mock/echo",
        provider: "provider-mock",
        contextWindow: 32_000,
        maxOutput: 512,
        supportsTools: true,
      },
    ];
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    const lastUser = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const text = lastUser?.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const hasToolResult = request.messages.some((message) => message.role === "tool");
    const reply = hasToolResult
      ? "mock: tool result received."
      : `mock: ${text ?? "(no input)"}`;

    for (const char of [...reply]) {
      if (signal.aborted) return;
      yield { type: "text", delta: char };
    }
    yield { type: "usage", input: 12, output: reply.length };
    yield { type: "stop", reason: "end" };
  }
}

const provider = new EchoProvider();

const module: ModuleExports = {
  init(ctx) {
    ctx.providers.register(provider);
  },
};

export default module;
export const init = module.init;
