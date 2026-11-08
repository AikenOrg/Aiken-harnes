import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";
import { lastJobId, lastToolResult, providerModule, ScriptedProvider, waitFor } from "../core/helpers.ts";

const tempDirs: string[] = [];

function config(): HarnessConfig {
  return { version: 1, modules: [], models: { default: "mock/script" } };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-harness-shell-"));
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

async function shellModule(mode: "full" | "whitelist", allow: string[]): Promise<ModuleDefinition> {
  const definition = await loadModuleDefinition("./src/modules/shell", process.cwd());
  definition.config = { mode, allow };
  return definition;
}

function holdModule(state: { aborted: boolean }): ModuleDefinition {
  return {
    manifest: {
      name: "tools-hold",
      version: "0.1.0",
      roles: [],
      critical: false,
      runner: "inprocess",
      permissions: [{ cap: "tool.register" }],
      tools: [{ name: "hold", mode: "async", timeoutMs: 60_000 }],
    },
    init(ctx) {
      ctx.tools.register({
        name: "hold",
        description: "Hold until cancelled.",
        mode: "async",
        input: z.object({}),
        handler: (_args, toolCtx) => {
          toolCtx.signal.addEventListener(
            "abort",
            () => {
              state.aborted = true;
            },
            { once: true },
          );
        },
      });
    },
  };
}

describe("async shell tool", () => {
  test("runs a whitelisted command, wait suppresses notification, read_result returns output", async () => {
    const shell = await shellModule("whitelist", ["echo", "sleep"]);
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "call_shell", name: "shell", args: { command: "sleep 0.1; echo hello" } }],
        stop: "tool_use",
      },
      (request) => ({
        toolCalls: [
          { id: "call_wait", name: "wait", args: { ids: [lastJobId(request)], timeoutMs: 2000 } },
        ],
        stop: "tool_use",
      }),
      (request) => ({
        toolCalls: [
          { id: "call_read", name: "read_result", args: { id: lastJobId(request) } },
        ],
        stop: "tool_use",
      }),
      { text: "finished", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), shell],
      autoApprove: true,
      ids: createSequentialIds("shell"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "run it");

    const job = harness.jobs.listJobs(session.id)[0];
    expect(job?.status).toBe("done");
    expect(harness.jobs.pendingNotifications(session.id)).toHaveLength(0);
    expect(events.some((event) => event.type === "job.notified")).toBe(false);

    const toolResults = harness.history
      .read(session.id)
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === "tool_result");
    const readResult = toolResults.find((block) => block.type === "tool_result" && block.name === "read_result");
    expect(readResult?.type).toBe("tool_result");
    expect((readResult as { content: string }).content).toContain("hello");
    expect(harness.history.read(session.id).at(-1)?.blocks[0]).toEqual({ type: "text", text: "finished" });
    await harness.stop();
  });

  test("cancel(id) kills the process and records by: ai", async () => {
    const dir = await tempDir();
    const marker = join(dir, "marker.txt");
    const shell = await shellModule("whitelist", ["sleep"]);
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            id: "call_shell",
            name: "shell",
            args: { command: "sleep 1; echo done > marker.txt", cwd: dir },
          },
        ],
        stop: "tool_use",
      },
      (request) => ({
        toolCalls: [{ id: "call_cancel", name: "cancel", args: { id: lastJobId(request) } }],
        stop: "tool_use",
      }),
      { text: "cancelled", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), shell],
      autoApprove: true,
      ids: createSequentialIds("cancel"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "start long command");

    const job = harness.jobs.listJobs(session.id)[0];
    expect(job?.status).toBe("cancelled");
    const cancelled = events.find((event) => event.type === "job.cancelled");
    expect((cancelled?.payload as { by?: string }).by).toBe("ai");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(existsSync(marker)).toBe(false);
    await harness.stop();
  });

  test("delivers AbortSignal to the tool module", async () => {
    const state = { aborted: false };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_hold", name: "hold", args: {} }], stop: "tool_use" },
      (request) => ({
        toolCalls: [{ id: "call_cancel", name: "cancel", args: { id: lastJobId(request) } }],
        stop: "tool_use",
      }),
      { text: "done", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), holdModule(state)],
      autoApprove: true,
      ids: createSequentialIds("signal"),
    });
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "hold");
    expect(state.aborted).toBe(true);
    expect(harness.jobs.listJobs(session.id)[0]?.status).toBe("cancelled");
    await harness.stop();
  });

  test("wait timeout does not cancel the job", async () => {
    const state = { aborted: false };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_hold", name: "hold", args: {} }], stop: "tool_use" },
      (request) => ({
        toolCalls: [
          { id: "call_wait", name: "wait", args: { ids: [lastJobId(request)], timeoutMs: 50 } },
        ],
        stop: "tool_use",
      }),
      { text: "still running", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), holdModule(state)],
      autoApprove: true,
      ids: createSequentialIds("wait"),
    });
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "wait a bit");
    const job = harness.jobs.listJobs(session.id)[0];
    expect(job?.status).toBe("running");
    const waitResult = lastToolResult(provider.requests.at(-1)!);
    expect(waitResult).toContain("running");
    harness.jobs.cancel(job!.id, "user");
    await harness.stop();
  });

  test("module death fails its running jobs with module_died", async () => {
    const state = { aborted: false };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_hold", name: "hold", args: {} }], stop: "tool_use" },
      { text: "holding", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), holdModule(state)],
      autoApprove: true,
      ids: createSequentialIds("death"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "hold");
    const job = harness.jobs.listJobs(session.id)[0]!;
    harness.failModule("tools-hold", { code: "module_died", message: "boom" });
    expect(harness.jobs.get(job.id)?.status).toBe("failed");
    const failed = events.find((event) => event.type === "job.failed");
    expect((failed?.payload as { error?: { code?: string } }).error?.code).toBe("module_died");
    await harness.stop();
  });

  test("whitelist denial prevents the job from starting", async () => {
    const shell = await shellModule("whitelist", ["echo"]);
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_bad", name: "shell", args: { command: "forbidden-command" } }], stop: "tool_use" },
      { text: "blocked", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), shell],
      autoApprove: true,
      ids: createSequentialIds("whitelist"),
    });
    const events = collect(harness);
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "try bad");
    expect(events.some((event) => event.type === "permission.denied")).toBe(true);
    expect(events.some((event) => event.type === "tool.failed")).toBe(true);
    expect(harness.jobs.listJobs(session.id)).toHaveLength(0);
    expect(harness.history.read(session.id).at(-1)?.blocks[0]).toEqual({ type: "text", text: "blocked" });
    await harness.stop();
  });

  test("full mode allows commands outside the whitelist", async () => {
    const shell = await shellModule("full", []);
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "call_shell", name: "shell", args: { command: "echo full-ok" } }], stop: "tool_use" },
      (request) => ({
        toolCalls: [{ id: "call_wait", name: "wait", args: { ids: [lastJobId(request)], timeoutMs: 2000 } }],
        stop: "tool_use",
      }),
      { text: "done", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), shell],
      autoApprove: true,
      ids: createSequentialIds("full"),
    });
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "full mode");
    await waitFor(() => harness.jobs.listJobs(session.id)[0]?.status === "done");
    expect(harness.jobs.listJobs(session.id)[0]?.status).toBe("done");
    await harness.stop();
  });
});
