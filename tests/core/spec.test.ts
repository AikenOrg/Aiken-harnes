import { describe, expect, test } from "bun:test";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { Message } from "../../src/protocol/messages.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { ERROR_CODES } from "../../src/protocol/common.ts";
import { z } from "zod";
import { providerModule, ScriptedProvider } from "./helpers.ts";

function config(model = "mock/script"): HarnessConfig {
  return { version: 1, modules: [], models: { default: model } };
}

function eventsOf(harness: Harness): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  harness.on("*", (event) => events.push(event));
  return events;
}

describe("M1 specification details", () => {
  test("orders prompt fragments and computes the cache boundary", async () => {
    const promptModule: ModuleDefinition = {
      manifest: {
        name: "prompt-test",
        version: "0.1.0",
        roles: [],
        critical: false,
        runner: "inprocess",
        permissions: [{ cap: "prompt.contribute" }],
      },
      init(ctx) {
        ctx.prompt.contribute({ id: "mod.static", stability: "static", priority: 100, content: "module static" });
        ctx.prompt.contribute({ id: "mod.session", stability: "session", priority: 500, content: "session" });
        ctx.prompt.contribute({ id: "mod.volatile", stability: "volatile", priority: 999, content: "volatile" });
      },
    };
    const harness = new Harness({
      config: { ...config(), prompt: { system: "config rules" } },
      modules: [providerModule(new ScriptedProvider([])), promptModule],
      autoApprove: true,
      ids: createSequentialIds("prompt"),
    });
    await harness.start();
    const session = harness.createSession();
    const assembled = await harness.prompt.assemble(session);
    expect(assembled.segments.map((segment) => segment.id)).toEqual([
      "config.system",
      "core.rules",
      "mod.static",
      "mod.session",
      "mod.volatile",
    ]);
    expect(assembled.cacheBoundary).toBe(3);
    await harness.stop();
  });

  test("restores history only for a restoring, empty session", async () => {
    const harness = new Harness({
      config: config(),
      modules: [providerModule(new ScriptedProvider([]))],
      autoApprove: true,
      ids: createSequentialIds("restore"),
    });
    await harness.start();
    const session = harness.createSession();
    const message: Message = {
      id: "msg_restored",
      role: "user",
      blocks: [{ type: "text", text: "old" }],
      createdAt: 1,
    };
    harness.sessions.setState(session.id, "restoring");
    harness.history.restore(session.id, [message]);
    expect(harness.sessions.get(session.id).state).toBe("idle");
    expect(harness.history.count(session.id)).toBe(1);
    expect(() => harness.history.restore(session.id, [message])).toThrow();
    await harness.stop();
  });

  test("wait delivers jobs without queueing notifications, and enforces the job limit", async () => {
    const harness = new Harness({
      config: config(),
      modules: [providerModule(new ScriptedProvider([]))],
      autoApprove: true,
      ids: createSequentialIds("jobspec"),
      maxConcurrentPerSession: 1,
    });
    await harness.start();
    const session = harness.createSession();

    const first = harness.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "call_1",
      tool: "slow",
      module: "tools-slow",
    });
    expect(() =>
      harness.jobs.create({
        sessionId: session.id,
        ownerSessionId: session.id,
        callId: "call_2",
        tool: "slow",
        module: "tools-slow",
      }),
    ).toThrow();

    harness.jobs.done(first.job.id, "tools-slow", { summary: "ok", result: "body" });
    const waited = await harness.jobs.wait([first.job.id], 100, session.id);
    expect(waited[0]?.status).toBe("done");
    expect(harness.jobs.pendingNotifications(session.id)).toHaveLength(0);
    await harness.stop();
  });

  test("tool.before denial emits permission.denied and tool.failed", async () => {
    const echoModule: ModuleDefinition = {
      manifest: {
        name: "tools-echo",
        version: "0.1.0",
        roles: [],
        critical: false,
        runner: "inprocess",
        permissions: [{ cap: "tool.register" }],
        tools: [{ name: "echo", mode: "sync" }],
      },
      init(ctx) {
        ctx.tools.register({
          name: "echo",
          description: "Echo.",
          mode: "sync",
          input: z.object({ text: z.string() }),
          handler: (args) => ({ content: (args as { text: string }).text }),
        });
      },
    };
    const hookModule: ModuleDefinition = {
      manifest: {
        name: "hook-deny",
        version: "0.1.0",
        roles: [],
        critical: false,
        runner: "inprocess",
        permissions: [{ cap: "tool.intercept" }],
      },
      init(ctx) {
        ctx.hooks.register("tool.before", () => ({ decision: "deny", reason: "nope" }));
      },
    };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_echo", name: "echo", args: { text: "hi" } }], stop: "tool_use" },
      { text: "after denial", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), echoModule, hookModule],
      autoApprove: true,
      ids: createSequentialIds("deny"),
    });
    const events = eventsOf(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "try");

    expect(events.some((event) => event.type === "permission.denied")).toBe(true);
    const failed = events.find((event) => event.type === "tool.failed");
    expect((failed?.payload as { error?: { code?: string } }).error?.code).toBe(ERROR_CODES.denied);
    const toolResult = harness.history
      .read(session.id)
      .find((message) => message.role === "tool")?.blocks[0];
    expect(toolResult).toMatchObject({ type: "tool_result", content: "nope", isError: true });
    expect(harness.history.read(session.id).at(-1)?.blocks[0]).toEqual({
      type: "text",
      text: "after denial",
    });
    await harness.stop();
  });
});
