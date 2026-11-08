import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { ModelEvent, ModelInfo, ModelRequest } from "../../src/protocol/provider.ts";
import type { Message } from "../../src/protocol/messages.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { providerModule } from "./helpers.ts";

class ReasoningProvider {
  requests: ModelRequest[] = [];
  models(): ModelInfo[] {
    return [
      {
        id: "mock/reason",
        provider: "mock",
        contextWindow: 100_000,
        maxOutput: 1_000,
        supportsTools: true,
        reasoning: { supported: true, efforts: ["low", "medium", "high", "max"] },
      },
    ];
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    this.requests.push(structuredClone(request));
    yield { type: "reasoning", delta: "secret thought" };
    yield { type: "reasoning_end", opaque: { kind: "signature", value: "signature-1" } };
    yield { type: "text", delta: "answer" };
    yield { type: "usage", input: 10, output: 5, reasoning: 3 };
    yield { type: "stop", reason: "end" };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeHarness(provider: ReasoningProvider): Harness {
  return new Harness({
    config: {
      version: 1,
      modules: [],
      models: {
        default: "mock/reason",
        "mock/reason": { reasoning: { effort: "high" } },
      },
    },
    modules: [providerModule(provider as never, "provider-reason")],
    autoApprove: true,
    ids: createSequentialIds("reason"),
  });
}

describe("reasoning", () => {
  test("stores reasoning as its own block and emits model.delta kind=reasoning", async () => {
    const provider = new ReasoningProvider();
    const harness = makeHarness(provider);
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const session = harness.createSession("mock/reason");
    await harness.send(session.id, "think");

    expect(provider.requests.at(0)?.params?.reasoning).toEqual({ effort: "high" });
    const history = harness.history.read(session.id);
    const assistant = history.filter((message) => message.role === "assistant").at(-1);
    expect(assistant?.blocks).toEqual([
      { type: "reasoning", text: "secret thought", opaque: { kind: "signature", value: "signature-1" } },
      { type: "text", text: "answer" },
    ]);
    const reasoningDelta = events.find(
      (event) => event.type === "model.delta" && (event.payload as { kind?: string }).kind === "reasoning",
    );
    expect(reasoningDelta?.payload).toEqual({
      v: 2,
      turnId: expect.any(String),
      text: "secret thought",
      kind: "reasoning",
    });
    const completed = events.find((event) => event.type === "model.completed");
    expect((completed?.payload as { usage: { reasoning: number } }).usage.reasoning).toBe(3);
    await harness.stop();
  });

  test("session override and agent.spawn reasoning win over config", async () => {
    const provider = new ReasoningProvider();
    const harness = makeHarness(provider);
    await harness.start();
    const parent = harness.createSession("mock/reason");
    harness.sessions.setReasoning(parent.id, { effort: "low" });
    await harness.send(parent.id, "parent");
    expect(provider.requests.at(0)?.params?.reasoning).toEqual({ effort: "low" });

    const spawned = await harness.spawnAgent({
      parentSessionId: parent.id,
      task: "child",
      model: "mock/reason",
      reasoning: { effort: "max" },
    });
    await waitFor(() => harness.jobs.get(spawned.jobId)?.status === "done");
    const childRequest = provider.requests.find((request) => request.sessionId === spawned.sessionId);
    expect(childRequest?.params?.reasoning).toEqual({ effort: "max" });
    const job = harness.jobs.get(spawned.jobId);
    expect(job?.summary).toBe("answer");
    expect(job?.summary).not.toContain("secret thought");
    const result = await harness.jobs.readResult(spawned.jobId, parent.id);
    expect(result.content).toBe("answer");
    await harness.stop();
  });

  test("marks a length-truncated turn instead of completed", async () => {
    class LengthProvider {
      models(): ModelInfo[] {
        return [
          {
            id: "mock/reason",
            provider: "mock",
            contextWindow: 100_000,
            maxOutput: 1_000,
            supportsTools: true,
            reasoning: { supported: true, efforts: ["high"] },
          },
        ];
      }
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        if (signal.aborted) return;
        yield { type: "reasoning", delta: "long thought" };
        yield { type: "text", delta: "partial answer" };
        yield { type: "stop", reason: "length" };
      }
    }
    const harness = new Harness({
      config: {
        version: 1,
        modules: [],
        models: { default: "mock/reason" },
        context: { maxOutputContinuations: 0 },
      },
      modules: [providerModule(new LengthProvider() as never, "provider-length")],
      autoApprove: true,
      ids: createSequentialIds("reasonlength"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const session = harness.createSession("mock/reason");
    await harness.send(session.id, "long");
    const ended = events.find((event) => event.type === "turn.ended" && event.sessionId === session.id);
    expect((ended?.payload as { reason: string }).reason).toBe("length");
    const assistant = harness.history
      .read(session.id)
      .filter((message) => message.role === "assistant")
      .at(-1);
    expect(assistant?.truncated).toBe(true);
    expect(assistant?.interrupted).toBeUndefined();
    expect(assistant?.blocks).toEqual([
      { type: "reasoning", text: "long thought" },
      { type: "text", text: "partial answer" },
    ]);
    expect(harness.sessions.get(session.id).state).toBe("idle");
    await harness.stop();
  });

  test("an agent job is failed with code length when the child is truncated", async () => {
    class LengthProvider {
      models(): ModelInfo[] {
        return [
          {
            id: "mock/reason",
            provider: "mock",
            contextWindow: 100_000,
            maxOutput: 1_000,
            supportsTools: true,
          },
        ];
      }
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        if (signal.aborted) return;
        yield { type: "reasoning", delta: "long thought" };
        yield { type: "stop", reason: "length" };
      }
    }
    const harness = new Harness({
      config: {
        version: 1,
        modules: [],
        models: { default: "mock/reason" },
        context: { maxOutputContinuations: 0 },
      },
      modules: [providerModule(new LengthProvider() as never, "provider-length")],
      autoApprove: true,
      ids: createSequentialIds("agentlength"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const parent = harness.createSession("mock/reason");
    const spawned = await harness.spawnAgent({ parentSessionId: parent.id, task: "long" });
    await waitFor(() => harness.jobs.get(spawned.jobId)?.status === "failed");
    const failed = events.find(
      (event) =>
        event.type === "job.failed" &&
        (event.payload as { jobId?: string }).jobId === spawned.jobId,
    );
    expect((failed?.payload as { error: { code: string } }).error.code).toBe("length");
    await harness.stop();
  });

  test("automatically continues after length and completes with the combined text", async () => {
    class ContinueProvider {
      calls = 0;
      models(): ModelInfo[] {
        return [
          {
            id: "mock/reason",
            provider: "mock",
            contextWindow: 100_000,
            maxOutput: 1_000,
            supportsTools: true,
          },
        ];
      }
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        if (signal.aborted) return;
        this.calls += 1;
        if (this.calls === 1) {
          yield { type: "text", delta: "part one " };
          yield { type: "stop", reason: "length" };
        } else {
          yield { type: "text", delta: "part two" };
          yield { type: "stop", reason: "end" };
        }
      }
    }
    const provider = new ContinueProvider();
    const harness = new Harness({
      config: { version: 1, modules: [], models: { default: "mock/reason" } },
      modules: [providerModule(provider as never, "provider-length")],
      autoApprove: true,
      ids: createSequentialIds("reasoncontinue"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const session = harness.createSession("mock/reason");
    await harness.send(session.id, "long");
    expect(provider.calls).toBe(2);
    const history = harness.history.read(session.id);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "system", "assistant"]);
    expect(history[1]?.truncated).toBe(true);
    expect(history[3]?.truncated).toBeUndefined();
    expect(history[3]?.blocks).toEqual([{ type: "text", text: "part two" }]);
    const end = events.find((event) => event.type === "turn.ended" && event.sessionId === session.id);
    expect((end?.payload as { reason: string }).reason).toBe("completed");
    await harness.stop();
  });

  test("stops after maxOutputContinuations and reports length", async () => {
    class AlwaysLengthProvider {
      calls = 0;
      models(): ModelInfo[] {
        return [
          {
            id: "mock/reason",
            provider: "mock",
            contextWindow: 100_000,
            maxOutput: 1_000,
            supportsTools: true,
          },
        ];
      }
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        if (signal.aborted) return;
        this.calls += 1;
        yield { type: "text", delta: `chunk ${this.calls}` };
        yield { type: "stop", reason: "length" };
      }
    }
    const provider = new AlwaysLengthProvider();
    const harness = new Harness({
      config: {
        version: 1,
        modules: [],
        models: { default: "mock/reason" },
        context: { maxOutputContinuations: 2 },
      },
      modules: [providerModule(provider as never, "provider-length")],
      autoApprove: true,
      ids: createSequentialIds("reasonlimit"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const session = harness.createSession("mock/reason");
    await harness.send(session.id, "long");
    expect(provider.calls).toBe(3);
    const history = harness.history.read(session.id);
    expect(history.filter((message) => message.role === "assistant")).toHaveLength(3);
    expect(history.filter((message) => message.role === "system")).toHaveLength(2);
    expect(history.filter((message) => message.role === "assistant").every((message) => message.truncated === true)).toBe(true);
    const end = events.find((event) => event.type === "turn.ended" && event.sessionId === session.id);
    expect((end?.payload as { reason: string }).reason).toBe("length");
    await harness.stop();
  });

  test("records a reasoning_ignored diagnostic on the session", async () => {
    class IgnoringProvider {
      models(): ModelInfo[] {
        return [
          {
            id: "mock/reason",
            provider: "mock",
            contextWindow: 100_000,
            maxOutput: 1_000,
            supportsTools: true,
            reasoning: { supported: false },
          },
        ];
      }
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        if (signal.aborted) return;
        yield { type: "reasoning_ignored", reason: "gateway does not expose reasoning" };
        yield { type: "text", delta: "answer" };
        yield { type: "stop", reason: "end" };
      }
    }
    const harness = new Harness({
      config: { version: 1, modules: [], models: { default: "mock/reason" } },
      modules: [providerModule(new IgnoringProvider() as never, "provider-ignore")],
      autoApprove: true,
      ids: createSequentialIds("reasonignore"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const session = harness.createSession("mock/reason");
    await harness.send(session.id, "hello");
    expect(harness.sessions.get(session.id).reasoningIgnored).toBe(
      "gateway does not expose reasoning",
    );
    expect(
      events.some(
        (event) =>
          event.type === "session.reasoning" &&
          (event.payload as { ignored?: string }).ignored ===
            "gateway does not expose reasoning",
      ),
    ).toBe(true);
    await harness.stop();
  });

  test("a reasoning block survives a cancelled turn as interrupted", async () => {
    class HangingProvider {
      models(): ModelInfo[] {
        return [
          {
            id: "mock/reason",
            provider: "mock",
            contextWindow: 100_000,
            maxOutput: 1_000,
            supportsTools: true,
            reasoning: { supported: true, efforts: ["high"] },
          },
        ];
      }
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        yield { type: "reasoning", delta: "partial thought" };
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }
    const harness = new Harness({
      config: { version: 1, modules: [], models: { default: "mock/reason" } },
      modules: [providerModule(new HangingProvider() as never, "provider-hang")],
      autoApprove: true,
      ids: createSequentialIds("reasoncancel"),
    });
    await harness.start();
    const session = harness.createSession("mock/reason");
    const sending = harness.send(session.id, "slow");
    await waitFor(() => harness.history.read(session.id).some((message) => message.role === "user"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.cancel(session.id, "user");
    await sending;
    const assistant = harness.history
      .read(session.id)
      .filter((message: Message) => message.role === "assistant")
      .at(-1);
    expect(assistant?.interrupted).toBe(true);
    expect(assistant?.blocks.at(0)).toEqual({ type: "reasoning", text: "partial thought" });
    await harness.stop();
  });
});
