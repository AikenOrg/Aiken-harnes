import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import type { ApprovalRequest } from "../../src/protocol/approval.ts";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { Job, JobResult, JobStatus } from "../../src/protocol/jobs.ts";
import type { Message } from "../../src/protocol/messages.ts";
import type { ModelInfo } from "../../src/protocol/provider.ts";
import type { Session } from "../../src/protocol/session.ts";
import { flattenSessionTree, isNearBottom } from "../../src/modules/ui-web/client/state.ts";
import {
  createUiServer,
  isAllowedHost,
  isAllowedOrigin,
  type UiBackend,
  type UiServerHandle,
} from "../../src/modules/ui-web/server.ts";

class FakeBackend implements UiBackend {
  sessions: Session[] = [];
  jobs: Job[] = [];
  sent: string[] = [];
  sentImages: Array<{ mediaType: string; data: string }> = [];
  cancelled: string[] = [];
  #handlers = new Set<(event: EventEnvelope) => void>();
  #seq = 0;
  #id = 0;

  async listSessions(): Promise<Session[]> {
    return this.sessions.map((session) => ({ ...session }));
  }
  async listRestorable(): Promise<Session[]> {
    return [];
  }
  listModels(): ModelInfo[] {
    return [
      {
        id: "mock/test",
        provider: "mock",
        contextWindow: 32_000,
        maxOutput: 512,
        supportsTools: true,
      },
    ];
  }
  async readHistory(sessionId: string): Promise<Message[]> {
    void sessionId;
    return [];
  }
  async countHistory(sessionId: string): Promise<number> {
    void sessionId;
    return 0;
  }
  async listJobs(sessionId: string, status?: JobStatus): Promise<Job[]> {
    return this.jobs.filter(
      (job) => job.ownerSessionId === sessionId && (status === undefined || job.status === status),
    );
  }
  async createSession(model: string): Promise<Session> {
    const session: Session = {
      id: `ses_${++this.#id}`,
      state: "idle",
      model,
      createdAt: Date.now(),
    };
    this.sessions.push(session);
    return session;
  }
  async restoreSession(sessionId: string): Promise<Session> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("not found");
    return session;
  }
  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("not found");
    session.model = model;
  }
  async setReasoning(
    sessionId: string,
    reasoning?: { effort?: "off" | "low" | "medium" | "high" | "max"; budgetTokens?: number },
  ): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("not found");
    if (reasoning === undefined) delete session.reasoning;
    else session.reasoning = reasoning;
  }
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (session) session.state = "closed";
  }
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions = this.sessions.filter((item) => item.id !== sessionId);
  }
  async send(
    sessionId: string,
    text: string,
    opts?: { images?: Array<{ mediaType: string; data: string }> },
  ): Promise<void> {
    this.sent.push(`${sessionId}:${text}`);
    if (opts?.images) this.sentImages.push(...opts.images);
    this.emit("user.message", { v: 1, text }, sessionId);
  }
  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }
  async cancelJob(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }
  async readJob(jobId: string): Promise<JobResult> {
    return {
      jobId,
      tool: "mock",
      status: "done",
      summary: "ok",
      size: 2,
      content: "ok",
      truncated: false,
    };
  }
  onEvent(handler: (event: EventEnvelope) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  log(): void {}
  emit(type: string, payload: unknown, sessionId?: string): void {
    const event: EventEnvelope = {
      id: `evt_${++this.#seq}`,
      seq: this.#seq,
      ts: Date.now(),
      type,
      source: "test",
      payload,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    for (const handler of this.#handlers) handler(event);
  }
}

const servers: UiServerHandle[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function serverWith(backend: UiBackend): UiServerHandle {
  const server = createUiServer(backend, { port: 0, seedColor: "#6750A4" });
  servers.push(server);
  return server;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rawHttp(port: number, request: string, untilHeaders = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (untilHeaders && data.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(request);
  });
}

function handshake(port: number, origin?: string, host?: string): string {
  return [
    "GET /ws HTTP/1.1",
    `Host: ${host ?? `127.0.0.1:${port}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...(origin !== undefined ? [`Origin: ${origin}`] : []),
    "",
    "",
  ].join("\r\n");
}

type ClientSocket = {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  command(type: string, payload?: unknown): Promise<Record<string, unknown>>;
};

async function openClient(server: UiServerHandle): Promise<ClientSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const messages: Array<Record<string, unknown>> = [];
  const pending = new Map<string, (value: Record<string, unknown>) => void>();
  let seq = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (typeof message.id === "string" && typeof message.ok === "boolean") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    messages.push(message);
  });
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
  await waitFor(() => messages.some((message) => message.type === "snapshot"));
  return {
    ws,
    messages,
    command(type, payload) {
      return new Promise((resolve) => {
        const id = `t${++seq}`;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, type, ...(payload !== undefined ? { payload } : {}) }));
      });
    },
  };
}

describe("ui-web security", () => {
  test("only loopback Host and Origin are accepted", () => {
    expect(isAllowedHost("127.0.0.1:8787", 8787)).toBe(true);
    expect(isAllowedHost("localhost:8787", 8787)).toBe(true);
    expect(isAllowedHost("evil.example:8787", 8787)).toBe(false);
    expect(isAllowedHost(undefined, 8787)).toBe(false);

    expect(isAllowedOrigin("http://127.0.0.1:8787", 8787)).toBe(true);
    expect(isAllowedOrigin("http://localhost:8787", 8787)).toBe(true);
    expect(isAllowedOrigin("http://evil.example:8787", 8787)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:9999", 8787)).toBe(false);
    expect(isAllowedOrigin(undefined, 8787)).toBe(true);
  });

  test("rejects a foreign Host, a foreign Origin, and mutating HTTP methods", async () => {
    const server = serverWith(new FakeBackend());
    expect(server.host).toBe("127.0.0.1");
    const badHost = await rawHttp(
      server.port,
      `GET / HTTP/1.1\r\nHost: evil.example:${server.port}\r\nConnection: close\r\n\r\n`,
    );
    expect(badHost).toContain("403");

    const badOrigin = await rawHttp(
      server.port,
      handshake(server.port, "http://evil.example", `127.0.0.1:${server.port}`),
      true,
    );
    expect(badOrigin).toContain("403");

    const badHostWs = await rawHttp(
      server.port,
      handshake(server.port, undefined, `evil.example:${server.port}`),
      true,
    );
    expect(badHostWs).toContain("403");

    const post = await fetch(`${server.url}/`, { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(await post.text()).toContain("method not allowed");

    const ok = await fetch(`${server.url}/`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain("<md-");

    const css = await fetch(`${server.url}/theme.css`);
    expect(await css.text()).toContain("--md-sys-color-primary");
  });

  test("accepts a non-browser WebSocket without Origin and serves the client bundle", async () => {
    const server = serverWith(new FakeBackend());
    const accepted = await rawHttp(server.port, handshake(server.port), true);
    expect(accepted).toContain("101");

    const bundle = await fetch(`${server.url}/app.js`);
    expect(bundle.status).toBe(200);
    expect((await bundle.text()).length).toBeGreaterThan(1_000);
  });
});

describe("ui-web protocol", () => {
  test("snapshot, session commands, jobs, and approval round trip", async () => {
    const backend = new FakeBackend();
    const server = serverWith(backend);
    const client = await openClient(server);
    const snapshot = client.messages.find((message) => message.type === "snapshot");
    expect(snapshot?.models).toHaveLength(1);
    expect(snapshot?.sessions).toHaveLength(0);

    const created = await client.command("session.create", { model: "mock/test" });
    expect(created.ok).toBe(true);
    const session = created.result as Session;
    expect(session.id).toBe("ses_1");

    const selected = await client.command("session.select", { sessionId: session.id });
    expect(selected.ok).toBe(true);

    const sent = await client.command("session.send", { sessionId: session.id, text: "hello" });
    expect(sent.ok).toBe(true);
    await waitFor(() => backend.sent.length === 1);
    expect(backend.sent[0]).toBe(`${session.id}:hello`);
    const imageSent = await client.command("session.send", {
      sessionId: session.id,
      text: "",
      images: [{ mediaType: "image/png", data: "YWJj" }],
    });
    expect(imageSent.ok).toBe(true);
    await waitFor(() => backend.sentImages.length === 1);
    expect(backend.sentImages[0]).toEqual({ mediaType: "image/png", data: "YWJj" });

    const cancelled = await client.command("session.cancel", { sessionId: session.id });
    expect(cancelled.ok).toBe(true);
    expect(backend.cancelled).toContain(session.id);

    const model = await client.command("session.setModel", {
      sessionId: session.id,
      model: "mock/test",
    });
    expect(model.ok).toBe(true);
    expect((model.result as Session).model).toBe("mock/test");
    await expect(
      client.command("session.setModel", { sessionId: session.id, model: "missing/model" }),
    ).resolves.toMatchObject({ ok: false });

    const reasoning = await client.command("session.setReasoning", {
      sessionId: session.id,
      reasoning: { effort: "high" },
    });
    expect(reasoning.ok).toBe(true);
    expect((reasoning.result as Session).reasoning).toEqual({ effort: "high" });
    const cleared = await client.command("session.setReasoning", {
      sessionId: session.id,
      reasoning: null,
    });
    expect(cleared.ok).toBe(true);
    expect((cleared.result as Session).reasoning).toBeUndefined();

    const jobs = await client.command("job.list", { sessionId: session.id });
    expect(jobs.ok).toBe(true);
    expect(jobs.result).toEqual([]);

    const approvalPromise = server.requestApproval({
      module: "demo",
      version: "0.1.0",
      roles: [],
      permissions: ["tool.register"],
      changes: ["new module"],
      warnings: [],
    });
    await waitFor(() => client.messages.some((message) => message.type === "approval.request"));
    const request = client.messages.find((message) => message.type === "approval.request");
    const approval = await client.command("approval.respond", {
      approvalId: request?.id,
      approved: true,
    });
    expect(approval.ok).toBe(true);
    await expect(approvalPromise).resolves.toEqual({ approved: true });
    client.ws.close();
  });

  test("closes and deletes sessions through commands", async () => {
    const backend = new FakeBackend();
    const server = serverWith(backend);
    const client = await openClient(server);
    const created = await client.command("session.create", { model: "mock/test" });
    const session = created.result as Session;
    const closed = await client.command("session.close", { sessionId: session.id });
    expect(closed.ok).toBe(true);
    expect(backend.sessions[0]?.state).toBe("closed");
    const deleted = await client.command("session.delete", { sessionId: session.id });
    expect(deleted.ok).toBe(true);
    expect(backend.sessions).toHaveLength(0);
    client.ws.close();
  });

  test("reconnect receives a fresh snapshot with the current sessions", async () => {
    const backend = new FakeBackend();
    const server = serverWith(backend);
    const first = await openClient(server);
    const created = await first.command("session.create", { model: "mock/test" });
    expect(created.ok).toBe(true);
    first.ws.close();
    const second = await openClient(server);
    const snapshot = second.messages.find((message) => message.type === "snapshot") as
      | { sessions: Session[] }
      | undefined;
    expect(snapshot?.sessions.map((session) => session.id)).toEqual(["ses_1"]);
    second.ws.close();
  });

  test("the session tree keeps parent/child depth and roots newest first", () => {
    const base = { state: "idle" as const, model: "mock/test", createdAt: 0 };
    const sessions: Session[] = [
      { ...base, id: "parent_old", createdAt: 1 },
      { ...base, id: "parent_new", createdAt: 2 },
      { ...base, id: "child", parentId: "parent_new", createdAt: 3 },
      { ...base, id: "grandchild", parentId: "child", createdAt: 4 },
    ];
    const rows = flattenSessionTree(sessions);
    expect(rows.map((row) => [row.session.id, row.depth])).toEqual([
      ["parent_new", 0],
      ["child", 1],
      ["grandchild", 2],
      ["parent_old", 0],
    ]);
  });

  test("detects whether a scroll box is following the bottom", () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1_000, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1_000, clientHeight: 100 })).toBe(false);
  });

  test("screen code does not use md-* elements directly and ships a dark palette", () => {
    const main = readFileSync("src/modules/ui-web/client/main.ts", "utf8");
    const state = readFileSync("src/modules/ui-web/client/state.ts", "utf8");
    expect(main).not.toContain("<md-");
    expect(state).not.toContain("<md-");
    const theme = readFileSync("src/modules/ui-web/theme.ts", "utf8");
    expect(theme).toContain("prefers-color-scheme");
    expect(theme).toContain("--md-sys-color-");
  });

  test("an approval request is included in a late client snapshot", async () => {
    const backend = new FakeBackend();
    const server = serverWith(backend);
    const request: ApprovalRequest = {
      module: "late",
      version: "1.0.0",
      roles: [],
      permissions: [],
      changes: [],
      warnings: [],
    };
    const pending = server.requestApproval(request);
    const client = await openClient(server);
    const snapshot = client.messages.find((message) => message.type === "snapshot") as
      | { approvals?: Array<{ id: string; request: ApprovalRequest }> }
      | undefined;
    expect(snapshot?.approvals?.[0]?.request.module).toBe("late");
    const id = snapshot?.approvals?.[0]?.id;
    if (id) {
      await client.command("approval.respond", { approvalId: id, approved: false });
    }
    await expect(pending).resolves.toEqual({ approved: false });
    client.ws.close();
  });
});
