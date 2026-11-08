import { afterEach, describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { Job } from "../../src/protocol/jobs.ts";
import type { Message } from "../../src/protocol/messages.ts";
import type { ModelEvent, ModelInfo } from "../../src/protocol/provider.ts";
import type { Session } from "../../src/protocol/session.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { ScriptedProvider, providerModule } from "../core/helpers.ts";

const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const harness of harnesses.splice(0)) await harness.stop();
});

class SlowProvider {
  modelsSeen: string[] = [];
  models(): ModelInfo[] {
    return [
      {
        id: "slow/model",
        provider: "slow",
        contextWindow: 100_000,
        maxOutput: 1_000,
        supportsTools: true,
      },
      {
        id: "slow/other",
        provider: "slow",
        contextWindow: 100_000,
        maxOutput: 1_000,
        supportsTools: true,
      },
    ];
  }
  async *stream(request: unknown, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    this.modelsSeen.push((request as { model: string }).model);
    yield { type: "text", delta: "partial answer" };
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

type Client = {
  ws: WebSocket;
  events: EventEnvelope[];
  command(type: string, payload?: unknown): Promise<Record<string, unknown>>;
};

async function openClient(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const events: EventEnvelope[] = [];
  const pending = new Map<string, (value: Record<string, unknown>) => void>();
  let seq = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (typeof message.id === "string" && typeof message.ok === "boolean") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (message.type === "event") events.push(message.event as EventEnvelope);
  });
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
  return {
    ws,
    events,
    command(type, payload) {
      return new Promise((resolve) => {
        const id = `h${++seq}`;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, type, ...(payload !== undefined ? { payload } : {}) }));
      });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startHarness(modules: ModuleDefinition[]): Promise<{ harness: Harness; port: number }> {
  const harness = new Harness({
    config: { version: 1, modules: [], models: { default: "slow/model" } },
    modules,
    autoApprove: true,
    ids: createSequentialIds("uiweb"),
  });
  harnesses.push(harness);
  await harness.start();
  const info = await harness.modules.callRole<{ port: number }>("ui", "info");
  return { harness, port: info.port };
}

async function createAndSelect(client: Client, model: string): Promise<Session> {
  const created = await client.command("session.create", { model });
  expect(created.ok).toBe(true);
  const session = created.result as Session;
  const selected = await client.command("session.select", { sessionId: session.id });
  expect(selected.ok).toBe(true);
  return session;
}

describe("ui-web with a real harness", () => {
  test("the snapshot exposes a parent and its two children as a tree", async () => {
    const provider = new ScriptedProvider(
      [
        { text: "child one", stop: "end" },
        { text: "child two", stop: "end" },
      ],
      { model: "mock/script" },
    );
    const ui = await loadModuleDefinition("./src/modules/ui-web", process.cwd());
    ui.config = { port: 0, host: "127.0.0.1" };
    const harness = new Harness({
      config: { version: 1, modules: [], models: { default: "mock/script" } },
      modules: [providerModule(provider, "provider-script"), ui],
      autoApprove: true,
      ids: createSequentialIds("uitree"),
    });
    harnesses.push(harness);
    await harness.start();
    const info = await harness.modules.callRole<{ port: number }>("ui", "info");
    const parent = harness.createSession("mock/script");
    const first = await harness.spawnAgent({ parentSessionId: parent.id, task: "one", model: "mock/script" });
    const second = await harness.spawnAgent({ parentSessionId: parent.id, task: "two", model: "mock/script" });
    await waitFor(
      () =>
        harness.jobs.get(first.jobId)?.status === "done" &&
        harness.jobs.get(second.jobId)?.status === "done",
    );
    const client = await openClient(info.port);
    const sessions = harness.sessions.list();
    expect(sessions.filter((session) => session.parentId === parent.id)).toHaveLength(2);
    const selected = await client.command("session.select", { sessionId: first.sessionId });
    expect(selected.ok).toBe(true);
    const messages = (selected.result as { messages: Message[] }).messages;
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
  });

  test("cancelling a running turn keeps the partial response as interrupted", async () => {
    const ui = await loadModuleDefinition("./src/modules/ui-web", process.cwd());
    ui.config = { port: 0, host: "127.0.0.1" };
    const provider = new SlowProvider();
    const { harness, port } = await startHarness([
      providerModule(provider as never, "provider-slow"),
      ui,
    ]);
    const client = await openClient(port);
    const session = await createAndSelect(client, "slow/model");
    const switched = await client.command("session.setModel", {
      sessionId: session.id,
      model: "slow/other",
    });
    expect(switched.ok).toBe(true);
    expect(harness.sessions.get(session.id).model).toBe("slow/other");
    await waitFor(() =>
      client.events.some(
        (event) =>
          event.type === "session.model" &&
          (event.payload as { model?: string }).model === "slow/other",
      ),
    );
    const reasoning = await client.command("session.setReasoning", {
      sessionId: session.id,
      reasoning: { effort: "high" },
    });
    expect(reasoning.ok).toBe(true);
    expect(harness.sessions.get(session.id).reasoning).toEqual({ effort: "high" });
    const sent = await client.command("session.send", { sessionId: session.id, text: "slow task" });
    expect(sent.ok).toBe(true);
    await waitFor(() =>
      client.events.some(
        (event) => event.type === "model.delta" && event.sessionId === session.id,
      ),
    );
    expect(provider.modelsSeen[0]).toBe("slow/other");
    const cancelled = await client.command("session.cancel", { sessionId: session.id });
    expect(cancelled.ok).toBe(true);
    await waitFor(() =>
      client.events.some(
        (event) => event.type === "turn.ended" && event.sessionId === session.id,
      ),
    );
    expect(
      client.events.some((event) => event.type === "user.cancel" && event.sessionId === session.id),
    ).toBe(true);
    const turnEnd = client.events.find(
      (event) => event.type === "turn.ended" && event.sessionId === session.id,
    );
    expect((turnEnd?.payload as { reason: string }).reason).toBe("cancelled");
    const history = await client.command("history.read", { sessionId: session.id, limit: 50 });
    const messages = (history.result as { messages: Message[] }).messages;
    const assistant = messages.filter((message) => message.role === "assistant").at(-1);
    expect(assistant?.interrupted).toBe(true);
    expect(assistant?.blocks[0]).toEqual({ type: "text", text: "partial answer" });
    expect(harness.sessions.get(session.id).state).toBe("idle");
  });

  test("a running shell job can be cancelled from the UI", async () => {
    const shell = await loadModuleDefinition("./src/modules/shell", process.cwd());
    shell.config = { mode: "whitelist", allow: ["sleep"] };
    const ui = await loadModuleDefinition("./src/modules/ui-web", process.cwd());
    ui.config = { port: 0, host: "127.0.0.1" };
    const provider = new ScriptedProvider(
      [
        {
          toolCalls: [{ id: "shell_1", name: "shell", args: { command: "sleep 20" } }],
          stop: "tool_use",
        },
        { text: "job started", stop: "end" },
      ],
      { model: "slow/model" },
    );
    const { port } = await startHarness([providerModule(provider, "provider-script"), shell, ui]);
    const client = await openClient(port);
    const session = await createAndSelect(client, "slow/model");
    await client.command("session.send", { sessionId: session.id, text: "run shell" });
    await waitFor(() =>
      client.events.some((event) => event.type === "job.running" && event.sessionId === session.id),
    );
    const listed = await client.command("job.list", { sessionId: session.id });
    const jobs = listed.result as Job[];
    const running = jobs.find((job) => job.status === "running");
    expect(running).toBeDefined();
    const cancelled = await client.command("job.cancel", { jobId: running?.id });
    expect(cancelled.ok).toBe(true);
    await waitFor(() =>
      client.events.some(
        (event) =>
          event.type === "job.cancelled" &&
          (event.payload as { jobId: string }).jobId === running?.id,
      ),
    );
    const after = await client.command("job.list", { sessionId: session.id });
    expect((after.result as Job[]).find((job) => job.id === running?.id)?.status).toBe("cancelled");
  });
});
