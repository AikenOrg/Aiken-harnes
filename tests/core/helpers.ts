import type { ModuleDefinition } from "../../src/core/module-host.ts";
import type { ModelEvent, ModelInfo, ModelRequest, Provider } from "../../src/protocol/provider.ts";
import type { ModuleContext } from "../../src/protocol/ctx.ts";

export type ScriptStep = {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  usage?: { input: number; output: number; cacheRead?: number };
  stop?: "end" | "tool_use" | "length" | "error";
};

export class ScriptedProvider implements Provider {
  #steps: ScriptStep[];
  #index = 0;
  #model: string;
  #contextWindow: number;
  #maxOutput: number;
  calls = 0;
  requests: ModelRequest[] = [];

  constructor(
    steps: ScriptStep[],
    options: { model?: string; contextWindow?: number; maxOutput?: number } = {},
  ) {
    this.#steps = steps;
    this.#model = options.model ?? "mock/script";
    this.#contextWindow = options.contextWindow ?? 100_000;
    this.#maxOutput = options.maxOutput ?? 1_000;
  }

  models(): ModelInfo[] {
    return [
      {
        id: this.#model,
        provider: "scripted",
        contextWindow: this.#contextWindow,
        maxOutput: this.#maxOutput,
        supportsTools: true,
      },
    ];
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    const step = this.#steps[this.#index++] ?? { text: "done", stop: "end" };
    if (signal.aborted) return;
    if (step.text) yield { type: "text", delta: step.text };
    for (const call of step.toolCalls ?? []) {
      yield { type: "tool_call", id: call.id, name: call.name, args: call.args };
    }
    if (step.usage) yield { type: "usage", ...step.usage };
    yield { type: "stop", reason: step.stop ?? "end" };
  }
}

export function providerModule(
  provider: Provider,
  name = "provider-test",
): ModuleDefinition {
  return {
    manifest: {
      name,
      version: "0.1.0",
      roles: ["provider"],
      critical: true,
      runner: "inprocess",
    },
    init(ctx: ModuleContext) {
      ctx.providers.register(provider);
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
