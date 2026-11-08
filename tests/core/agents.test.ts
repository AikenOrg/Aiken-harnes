import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";
import { lastJobId, providerModule, ScriptedProvider, waitFor } from "./helpers.ts";

const tempDirs: string[] = [];

function config(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { version: 1, modules: [], models: { default: "parent/model" }, ...overrides };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iken-harnes-agent-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function agentModules(): Promise<ModuleDefinition[]> {
  return [
    await loadModuleDefinition("./src/modules/tools-agent", process.cwd()),
    await loadModuleDefinition("./src/modules/tools-read", process.cwd()),
  ];
}

describe("agents", () => {
  test("parent spawns a child, waits, and reads the child final response", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "README.md"), "agent read this", "utf8");
    const parentProvider = new ScriptedProvider(
      [
        {
          toolCalls: [
            {
              id: "spawn_1",
              name: "spawn_agent",
              args: { task: "Read README.md and summarize", model: "child/model" },
            },
          ],
          stop: "tool_use",
        },
        (request) => ({
          toolCalls: [
            { id: "wait_1", name: "wait", args: { ids: [lastJobId(request)], timeoutMs: 5000 } },
          ],
          stop: "tool_use",
        }),
        (request) => ({
          toolCalls: [
            { id: "read_1", name: "read_result", args: { id: lastJobId(request) } },
          ],
          stop: "tool_use",
        }),
        { text: "parent complete", stop: "end" },
      ],
      { model: "parent/model" },
    );
    const childProvider = new ScriptedProvider(
      [
        { toolCalls: [{ id: "child_read", name: "read", args: { path: "README.md" } }], stop: "tool_use" },
        { text: "child summary", stop: "end" },
      ],
      { model: "child/model" },
    );
    const modules = [
      providerModule(parentProvider, "provider-parent"),
      providerModule(childProvider, "provider-child"),
      ...(await agentModules()),
    ];
    const harness = new Harness({
      config: config(),
      modules,
      autoApprove: true,
      baseDir: dir,
      ids: createSequentialIds("agentflow"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const parent = harness.createSession("parent/model");
    await harness.send(parent.id, "delegate");

    const agents = harness.sessions.list().filter((session) => session.parentId === parent.id);
    expect(agents).toHaveLength(1);
    const child = agents[0]!;
    expect(child.toolNames).not.toContain("spawn_agent");
    expect(child.toolNames).toContain("read");

    const spawnEvent = events.find((event) => event.type === "agent.spawned");
    expect((spawnEvent?.payload as { tools: string[] }).tools).not.toContain("spawn_agent");
    const jobs = harness.jobs.listJobs(parent.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("done");
    const result = await harness.jobs.readResult(jobs[0]!.id, parent.id);
    expect(result.content).toBe("child summary");
    expect(harness.history.read(parent.id).at(-1)?.blocks[0]).toEqual({
      type: "text",
      text: "parent complete",
    });
    await harness.stop();
  });

  test("notifies the parent without wait, and send to an idle child starts a new turn", async () => {
    const parentProvider = new ScriptedProvider(
      [
        {
          toolCalls: [
            {
              id: "spawn_2",
              name: "spawn_agent",
              args: { task: "do child work", model: "child/model" },
            },
          ],
          stop: "tool_use",
        },
        { text: "started", stop: "end" },
        { text: "notified", stop: "end" },
      ],
      { model: "parent/model" },
    );
    const childProvider = new ScriptedProvider(
      [
        { text: "child first", stop: "end" },
        { text: "child second", stop: "end" },
      ],
      { model: "child/model" },
    );
    const harness = new Harness({
      config: config(),
      modules: [
        providerModule(parentProvider, "provider-parent"),
        providerModule(childProvider, "provider-child"),
        ...(await agentModules()),
      ],
      autoApprove: true,
      ids: createSequentialIds("agentnotify"),
    });
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const parent = harness.createSession("parent/model");
    await harness.send(parent.id, "start child");
    const child = harness.sessions.list().find((session) => session.parentId === parent.id)!;
    const job = harness.jobs.listJobs(parent.id)[0]!;
    // The first child turn is complete; notification is queued for the parent.
    const deadline = Date.now() + 2_000;
    while (job.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await harness.send(parent.id, "continue");
    const notification = harness.history.read(parent.id).find((message) => message.role === "notification");
    expect(notification).toBeDefined();
    const entries = notification?.blocks[0];
    expect(entries?.type).toBe("notification");

    await harness.sendAgent(parent.id, child.id, "second task");
    expect(child.state === "idle" || child.state === "active").toBe(true);
    const childJob = harness.jobs.listJobs(parent.id).find((candidate) => candidate.tool === "agent.message");
    expect(childJob).toBeDefined();
    await harness.stop();
  });

  test("cancel interrupts the child turn and marks the agent job cancelled by ai", async () => {
    class HangingProvider {
      models() {
        return [{ id: "child/hang", provider: "child", contextWindow: 100_000, maxOutput: 1_000 }];
      }
      async *stream(_request: unknown, signal: AbortSignal) {
        yield { type: "text", delta: "child partial" } as const;
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }
    const harness = new Harness({
      config: config(),
      modules: [
        providerModule(new ScriptedProvider([], { model: "parent/model" }), "provider-parent"),
        providerModule(new HangingProvider() as never, "provider-child"),
        ...(await agentModules()),
      ],
      autoApprove: true,
      ids: createSequentialIds("agentcancel"),
    });
    await harness.start();
    const parent = harness.createSession("parent/model");
    const spawned = await harness.spawnAgent({
      parentSessionId: parent.id,
      task: "hang",
      model: "child/hang",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.cancelAgent(parent.id, spawned.sessionId);
    const job = harness.jobs.get(spawned.jobId);
    expect(job?.status).toBe("cancelled");
    expect(job?.cancelBy).toBe("ai");
    await waitFor(() => harness.sessions.get(spawned.sessionId).state === "idle");
    expect(harness.sessions.get(spawned.sessionId).state).toBe("idle");
    await harness.stop();
  });

  test("cancelAgent cancels a running shell job in the child", async () => {
    const childProvider = new ScriptedProvider(
      [
        { toolCalls: [{ id: "child_shell", name: "shell", args: { command: "sleep 30" } }], stop: "tool_use" },
        { text: "child still running", stop: "end" },
      ],
      { model: "child/model" },
    );
    const shell = await loadModuleDefinition("./src/modules/shell", process.cwd());
    shell.config = { mode: "whitelist", allow: ["sleep"] };
    const harness = new Harness({
      config: config(),
      modules: [
        providerModule(new ScriptedProvider([], { model: "parent/model" }), "provider-parent"),
        providerModule(childProvider, "provider-child"),
        ...(await agentModules()),
        shell,
      ],
      autoApprove: true,
      ids: createSequentialIds("agentshell"),
    });
    await harness.start();
    const parent = harness.createSession("parent/model");
    const spawned = await harness.spawnAgent({
      parentSessionId: parent.id,
      task: "run a long shell",
      model: "child/model",
    });
    await waitFor(
      () => harness.jobs.listJobs(spawned.sessionId).some((job) => job.tool === "shell" && job.status === "running"),
      2_000,
    );
    await harness.cancelAgent(parent.id, spawned.sessionId);
    const shellJob = harness.jobs.listJobs(spawned.sessionId).find((job) => job.tool === "shell");
    expect(shellJob?.status).toBe("cancelled");
    expect(shellJob?.cancelBy).toBe("ai");
    await harness.stop();
  });

  test("close cascades and child operations outside scope are rejected", async () => {
    const harness = new Harness({
      config: config({ agents: { maxDepth: 3, maxChildren: 8, maxAgents: 16 } }),
      modules: [
        providerModule(new ScriptedProvider([], { model: "parent/model" }), "provider-parent"),
        providerModule(new ScriptedProvider([], { model: "child/model" }), "provider-child"),
        ...(await agentModules()),
      ],
      autoApprove: true,
      ids: createSequentialIds("agentscope"),
    });
    await harness.start();
    const parent = harness.createSession("parent/model");
    const child = harness.sessions.create({ model: "child/model", parentId: parent.id });
    const grandchild = harness.sessions.create({ model: "child/model", parentId: child.id });

    await expect(harness.sendAgent(child.id, parent.id, "no")).rejects.toThrow(/outside scope/);
    await expect(harness.cancelAgent(child.id, parent.id)).rejects.toThrow(/outside scope/);
    await expect(harness.closeAgent(child.id, parent.id)).rejects.toThrow(/outside scope/);
    await expect(harness.listAgents(child.id)).resolves.toHaveLength(1);

    await harness.closeAgent(parent.id, child.id);
    expect(harness.sessions.get(child.id).state).toBe("closed");
    expect(harness.sessions.get(grandchild.id).state).toBe("closed");
    await harness.stop();
  });

  test("agent.route can deny send and spawn", async () => {
    const hookModule: ModuleDefinition = {
      manifest: {
        name: "hook-agent-route",
        version: "0.1.0",
        roles: [],
        critical: false,
        runner: "inprocess",
        permissions: [{ cap: "agent.message" }],
      },
      init(ctx) {
        ctx.hooks.register("agent.route", (input) => {
          const value = input as { text?: string };
          if (value.text?.includes("blocked")) return { decision: "deny", reason: "blocked by route" };
        });
      },
    };
    const childProvider = new ScriptedProvider([{ text: "child", stop: "end" }], { model: "child/model" });
    const harness = new Harness({
      config: config(),
      modules: [
        providerModule(new ScriptedProvider([], { model: "parent/model" }), "provider-parent"),
        providerModule(childProvider, "provider-child"),
        ...(await agentModules()),
        hookModule,
      ],
      autoApprove: true,
      ids: createSequentialIds("agentroute"),
    });
    await harness.start();
    const parent = harness.createSession("parent/model");
    await expect(
      harness.spawnAgent({ parentSessionId: parent.id, task: "blocked task", model: "child/model" }),
    ).rejects.toThrow(/blocked by route/);
    const child = await harness.spawnAgent({ parentSessionId: parent.id, task: "ok", model: "child/model" });
    await expect(harness.sendAgent(parent.id, child.sessionId, "blocked message")).rejects.toThrow(/blocked by route/);
    await harness.stop();
  });

  test("the global maxAgents limit is enforced", async () => {
    const harness = new Harness({
      config: config({ agents: { maxChildren: 8, maxAgents: 1 } }),
      modules: [
        providerModule(new ScriptedProvider([], { model: "parent/model" }), "provider-parent"),
        providerModule(new ScriptedProvider([], { model: "child/model" }), "provider-child"),
        ...(await agentModules()),
      ],
      autoApprove: true,
      ids: createSequentialIds("agentmax"),
    });
    await harness.start();
    const parent = harness.createSession("parent/model");
    await harness.spawnAgent({ parentSessionId: parent.id, task: "one", model: "child/model" });
    await expect(
      harness.spawnAgent({ parentSessionId: parent.id, task: "two", model: "child/model" }),
    ).rejects.toThrow(/agent count limit/);
    await harness.stop();
  });

  test("maxConcurrentModelCalls queues parallel child turns", async () => {
    let active = 0;
    let maxActive = 0;
    class SlowProvider {
      calls = 0;
      models() {
        return [
          { id: "slow/model", provider: "slow", contextWindow: 100_000, maxOutput: 1_000, supportsTools: true },
        ];
      }
      async *stream(_request: unknown, signal: AbortSignal) {
        if (signal.aborted) return;
        this.calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        yield { type: "text", delta: "child done" } as const;
        yield { type: "stop", reason: "end" } as const;
      }
    }
    const provider = new SlowProvider();
    const harness = new Harness({
      config: config({ agents: { maxConcurrentModelCalls: 1 } }),
      modules: [providerModule(provider as never, "provider-slow")],
      autoApprove: true,
      ids: createSequentialIds("agentslow"),
    });
    await harness.start();
    const parent = harness.createSession("slow/model");
    const first = await harness.spawnAgent({ parentSessionId: parent.id, task: "one", model: "slow/model" });
    const second = await harness.spawnAgent({ parentSessionId: parent.id, task: "two", model: "slow/model" });
    await waitFor(
      () =>
        harness.jobs.get(first.jobId)?.status === "done" &&
        harness.jobs.get(second.jobId)?.status === "done",
      3_000,
    );
    expect(maxActive).toBe(1);
    expect(provider.calls).toBe(2);
    await harness.stop();
  });

  test("autoWake stops after maxAutoWakeStreak", async () => {
    const provider = new ScriptedProvider([{ text: "woke up", stop: "end" }], { model: "mock/script" });
    const harness = new Harness({
      config: config({ jobs: { maxAutoWakeStreak: 1 } }),
      modules: [providerModule(provider, "provider-wake")],
      autoApprove: true,
      ids: createSequentialIds("agentwake"),
    });
    await harness.start();
    const session = harness.createSession("mock/script", { autoWake: true });

    const first = harness.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "wake_1",
      tool: "test",
      module: "test",
    });
    harness.jobs.done(first.job.id, "test", { summary: "first", result: "first" });
    await waitFor(() => provider.calls === 1);
    await waitFor(() => session.state === "idle");

    const second = harness.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "wake_2",
      tool: "test",
      module: "test",
    });
    harness.jobs.done(second.job.id, "test", { summary: "second", result: "second" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.calls).toBe(1);
    expect(harness.jobs.pendingNotifications(session.id)).toHaveLength(1);
    await harness.stop();
  });

  test("enforces depth, child count, agent count, prompt size, and tool subsets", async () => {
    const parentProvider = new ScriptedProvider([], { model: "parent/model" });
    const childProvider = new ScriptedProvider([], { model: "child/model" });
    const harness = new Harness({
      config: config({ agents: { maxDepth: 1, maxChildren: 1, maxAgents: 2, maxPromptBytes: 16 } }),
      modules: [
        providerModule(parentProvider, "provider-parent"),
        providerModule(childProvider, "provider-child"),
        ...(await agentModules()),
      ],
      autoApprove: true,
      ids: createSequentialIds("agentlimits"),
    });
    await harness.start();
    const parent = harness.createSession("parent/model");
    await expect(
      harness.spawnAgent({ parentSessionId: parent.id, task: "too much prompt", prompt: "x".repeat(17) }),
    ).rejects.toThrow(/prompt exceeds/);
    await expect(
      harness.spawnAgent({ parentSessionId: parent.id, task: "bad tools", tools: ["not-a-tool"] }),
    ).rejects.toThrow(/tool is not available/);

    const first = await harness.spawnAgent({ parentSessionId: parent.id, task: "one" });
    await expect(harness.spawnAgent({ parentSessionId: parent.id, task: "two" })).rejects.toThrow(/child session limit/);
    await expect(
      harness.spawnAgent({ parentSessionId: first.sessionId, task: "grandchild" }),
    ).rejects.toThrow(/agent depth limit/);
    await harness.stop();
  });
});
