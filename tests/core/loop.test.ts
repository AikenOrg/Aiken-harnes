import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";
import { providerModule, ScriptedProvider, waitFor } from "./helpers.ts";

const tempDirs: string[] = [];

function config(model: string): HarnessConfig {
  return {
    version: 1,
    modules: [],
    models: { default: model },
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-harness-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function collect(harness: Harness): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  harness.on("*", (event) => events.push(event));
  return events;
}

describe("M1 core loop", () => {
  test("runs a provider module and records history", async () => {
    const provider = await loadModuleDefinition("./src/modules/provider-mock", process.cwd());
    const harness = new Harness({
      config: config("mock/echo"),
      modules: [provider],
      autoApprove: true,
      ids: createSequentialIds("loop"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "hello");

    const history = harness.history.read(session.id);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history[0]?.blocks[0]).toEqual({ type: "text", text: "hello" });
    expect(history[1]?.blocks[0]).toEqual({ type: "text", text: "mock: hello" });
    expect(events.some((event) => event.type === "turn.started")).toBe(true);
    expect(events.some((event) => event.type === "prompt.assembled")).toBe(true);
    expect(events.some((event) => event.type === "model.completed")).toBe(true);
    expect(events.some((event) => event.type === "turn.ended" && (event.payload as { reason?: string }).reason === "completed")).toBe(true);
    expect(events[0]?.id.startsWith("evt_loopboot_")).toBe(true);
    await harness.stop();
  });

  test("executes a sync tool and feeds the result back", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "hello.txt"), "hello from file", "utf8");
    const readModule = await loadModuleDefinition("./src/modules/tools-read", process.cwd());
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "call_1", name: "read", args: { path: "hello.txt" } }],
        usage: { input: 10, output: 2 },
        stop: "tool_use",
      },
      { text: "done", usage: { input: 20, output: 1 }, stop: "end" },
    ]);
    const harness = new Harness({
      config: config("mock/script"),
      modules: [providerModule(provider), readModule],
      autoApprove: true,
      baseDir: dir,
      ids: createSequentialIds("tool"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "read it");

    expect(provider.calls).toBe(2);
    const history = harness.history.read(session.id);
    const toolResult = history.find(
      (message) => message.role === "tool" && message.blocks[0]?.type === "tool_result",
    );
    expect(toolResult?.blocks[0]).toMatchObject({ type: "tool_result", content: "hello from file" });
    expect(history.at(-1)?.blocks[0]).toEqual({ type: "text", text: "done" });
    expect(events.some((event) => event.type === "tool.requested")).toBe(true);
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(harness.sessions.get(session.id).lastInputTokens).toBe(20);
    await harness.stop();
  });

  test("stops with context_overflow when the next request would exceed the limit", async () => {
    const provider = new ScriptedProvider([], { contextWindow: 100, maxOutput: 10 });
    const harness = new Harness({
      config: config("mock/script"),
      modules: [providerModule(provider)],
      autoApprove: true,
      ids: createSequentialIds("overflow"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    harness.sessions.setLastInputTokens(session.id, 100);
    await harness.send(session.id, "too large");

    expect(provider.calls).toBe(0);
    expect(
      events.some((event) => event.type === "turn.ended" && (event.payload as { reason?: string }).reason === "context_overflow"),
    ).toBe(true);
    await harness.stop();
  });

  test("queues async job notifications for the next model call", async () => {
    const slowModule: ModuleDefinition = {
      manifest: {
        name: "tools-slow",
        version: "0.1.0",
        roles: [],
        critical: false,
        runner: "inprocess",
        permissions: [{ cap: "tool.register" }],
        tools: [{ name: "slow", mode: "async", timeoutMs: 1_000 }],
      },
      init(ctx) {
        ctx.tools.register({
          name: "slow",
          description: "Finish later.",
          mode: "async",
          input: z.object({}),
          handler: (_args, toolCtx) => {
            setTimeout(() => {
              if (toolCtx.jobId) ctx.jobs.done(toolCtx.jobId, { summary: "slow done", result: "payload" });
            }, 10);
          },
        });
      },
    };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_slow", name: "slow", args: {} }], stop: "tool_use" },
      { text: "started", stop: "end" },
      { text: "continued", stop: "end" },
    ]);
    const harness = new Harness({
      config: config("mock/script"),
      modules: [providerModule(provider), slowModule],
      autoApprove: true,
      ids: createSequentialIds("job"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "start");

    const job = harness.jobs.listJobs(session.id)[0];
    expect(job).toBeDefined();
    await waitFor(() => harness.jobs.get(job!.id)?.status === "done");
    await harness.send(session.id, "continue");

    const notification = harness.history
      .read(session.id)
      .find((message) => message.role === "notification");
    expect(notification?.blocks[0]).toMatchObject({
      type: "notification",
      entries: [{ id: job!.id, status: "done", summary: "slow done" }],
    });
    expect(events.some((event) => event.type === "job.done")).toBe(true);
    expect(events.some((event) => event.type === "job.notified")).toBe(true);
    await harness.stop();
  });

  test("closes descendants and deletes only closed sessions", async () => {
    const provider = new ScriptedProvider([]);
    const harness = new Harness({
      config: config("mock/script"),
      modules: [providerModule(provider)],
      autoApprove: true,
      ids: createSequentialIds("session"),
    });
    const events = collect(harness);
    await harness.start();
    const parent = harness.createSession();
    const child = harness.sessions.create({ model: "mock/script", parentId: parent.id });

    harness.closeSession(parent.id);
    expect(harness.sessions.get(parent.id).state).toBe("closed");
    expect(harness.sessions.get(child.id).state).toBe("closed");

    await harness.deleteSession(child.id);
    await harness.deleteSession(parent.id);
    expect(() => harness.sessions.get(parent.id)).toThrow();
    expect(events.some((event) => event.type === "session.deleted")).toBe(true);
    await harness.stop();
  });
});

describe("turn cancellation", () => {
  test("keeps partial text as interrupted and ends cancelled", async () => {
    class HangingProvider {
      models() {
        return [{ id: "mock/hang", provider: "hanging", contextWindow: 100_000, maxOutput: 1_000 }];
      }
      async *stream(_request: unknown, signal: AbortSignal) {
        yield { type: "text", delta: "partial" } as const;
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }
    const harness = new Harness({
      config: { version: 1, modules: [], models: { default: "mock/hang" } },
      modules: [providerModule(new HangingProvider() as never)],
      autoApprove: true,
      ids: createSequentialIds("cancelmodel"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    const pending = harness.send(session.id, "long");
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.cancel(session.id, "user");
    await pending;

    expect(events.some((event) => event.type === "model.failed")).toBe(false);
    expect(
      events.some((event) => event.type === "turn.ended" && (event.payload as { reason?: string }).reason === "cancelled"),
    ).toBe(true);
    const assistant = harness.history.read(session.id).find((message) => message.role === "assistant");
    expect(assistant?.interrupted).toBe(true);
    expect(assistant?.blocks[0]).toEqual({ type: "text", text: "partial" });
    await harness.stop();
  });
});
