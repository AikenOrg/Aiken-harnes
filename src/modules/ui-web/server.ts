import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApprovalDecision, ApprovalRequest } from "../../protocol/approval.ts";
import type { EventEnvelope } from "../../protocol/events.ts";
import type { Job, JobResult, JobStatus } from "../../protocol/jobs.ts";
import type { Message } from "../../protocol/messages.ts";
import type { ModelInfo } from "../../protocol/provider.ts";
import type { ReasoningParams } from "../../protocol/reasoning.ts";
import type { Session } from "../../protocol/session.ts";
import {
  optionalNumber,
  optionalString,
  recordOf,
  requiredString,
  type ClientCommand,
  type CommandError,
  type CommandResponse,
  type HistoryReadResult,
  type JobReadOptions,
  type PendingApproval,
  type SelectResult,
  type ServerMessage,
  type SnapshotData,
  type UiWebConfig,
} from "./protocol.ts";
import { createThemeCss } from "./theme.ts";

export type UiBackend = {
  listSessions(): Promise<Session[]>;
  listRestorable(): Promise<Session[]>;
  listModels(): ModelInfo[];
  readHistory(sessionId: string, options?: { limit?: number; before?: string }): Promise<Message[]>;
  countHistory(sessionId: string): Promise<number>;
  listJobs(sessionId: string, status?: JobStatus): Promise<Job[]>;
  createSession(model: string): Promise<Session>;
  restoreSession(sessionId: string): Promise<Session>;
  setModel(sessionId: string, model: string): Promise<void>;
  setReasoning(sessionId: string, reasoning?: ReasoningParams): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  readJob(jobId: string, options: JobReadOptions): Promise<JobResult>;
  onEvent(handler: (event: EventEnvelope) => void): () => void;
  log(level: "debug" | "info" | "warn" | "error", message: string, meta?: unknown): void;
};

export type UiServerHandle = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  close(): void;
};

type Socket = {
  send(data: string): unknown;
  readyState: number;
};

type SocketData = {
  id: number;
};

type Pending = {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

const OPEN = 1;
const DEFAULT_PORT = 8787;
const DEFAULT_SEED = "#6750A4";

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (value === "127.0.0.1" || value === "localhost") return port === 80;
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const originPort = parsed.port.length > 0 ? parsed.port : "80";
  if (originPort !== String(port)) return false;
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}

function securityHeaders(port: number): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    ].join("; "),
  };
}

function commandError(error: unknown): CommandError {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "command_failed",
      message: error.message,
    };
  }
  return { code: "command_failed", message: String(error) };
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function indexHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>next-harness</title>
  <link rel="stylesheet" href="/theme.css">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

const clientEntry = fileURLToPath(new URL("./client/main.ts", import.meta.url));
const stylesPath = fileURLToPath(new URL("./client/styles.css", import.meta.url));

/** UI の HTTP/WS サーバー。状態変更は WebSocket の command だけを受け付ける。 */
export function createUiServer(backend: UiBackend, config: UiWebConfig = {}): UiServerHandle {
  const host = config.host ?? "127.0.0.1";
  const requestedPort = config.port ?? DEFAULT_PORT;
  const seedColor = config.seedColor ?? DEFAULT_SEED;
  const historyLimit = config.historyLimit ?? 200;
  const approvalTimeoutMs = config.approvalTimeoutMs ?? 300_000;
  const clients = new Set<Socket>();
  const pending = new Map<string, Pending>();
  const deltas = new Map<string, { event: EventEnvelope; text: string }>();
  let approvalSeq = 0;
  let socketSeq = 0;
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let server: { readonly port?: number | undefined; stop(force?: boolean): void } | undefined;
  let bundlePromise: Promise<string> | undefined;
  let unsubscribe: (() => void) | undefined;
  const themeCss = createThemeCss(seedColor);
  const stylesCss = readFileSync(stylesPath, "utf8");
  const html = indexHtml();

  const currentPort = (): number => server?.port ?? requestedPort;

  function sendRaw(socket: Socket, data: string): void {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(data);
    } catch (error) {
      backend.log("warn", "failed to send websocket message", error);
    }
  }

  function send(socket: Socket, message: ServerMessage | CommandResponse): void {
    sendRaw(socket, JSON.stringify(message));
  }

  function broadcast(message: ServerMessage | CommandResponse): void {
    const data = JSON.stringify(message);
    for (const socket of clients) sendRaw(socket, data);
  }

  async function snapshot(selectedSessionId?: string): Promise<SnapshotData> {
    const sessions = await backend.listSessions();
    const restorable = await backend.listRestorable().catch(() => []);
    const fallback = sessions
      .filter((session) => session.parentId === undefined && session.state !== "closed")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const selected = selectedSessionId ?? fallback?.id;
    const valid = selected !== undefined && sessions.some((session) => session.id === selected);
    const selectedId = valid ? selected : undefined;
    const messages = selectedId ? await backend.readHistory(selectedId, { limit: historyLimit }) : [];
    const messageCount = selectedId ? await backend.countHistory(selectedId) : 0;
    const jobs = selectedId ? await backend.listJobs(selectedId) : [];
    const result: SnapshotData = {
      sessions,
      messages,
      messageCount,
      jobs,
      restorable,
      models: backend.listModels(),
      approvals: pendingApprovals(),
    };
    if (selectedId !== undefined) result.selectedSessionId = selectedId;
    return result;
  }

  function pendingApprovals(): PendingApproval[] {
    return [...pending.entries()].map(([id, item]) => ({ id, request: item.request }));
  }

  function flushDeltas(): void {
    if (deltaTimer !== undefined) {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
    }
    if (deltas.size === 0) return;
    for (const item of deltas.values()) {
      const merged: EventEnvelope = {
        ...item.event,
        payload: { ...recordOf(item.event.payload), text: item.text },
      };
      broadcast({ type: "event", event: merged });
    }
    deltas.clear();
  }

  function queueDelta(event: EventEnvelope): void {
    const payload = recordOf(event.payload);
    const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
    const text = typeof payload.text === "string" ? payload.text : "";
    const key = `${event.sessionId ?? ""}:${turnId}`;
    const existing = deltas.get(key);
    if (existing) {
      existing.text += text;
      existing.event = event;
    } else {
      deltas.set(key, { event, text });
    }
    if (deltaTimer !== undefined) return;
    deltaTimer = setTimeout(flushDeltas, 40);
  }

  function resolveApproval(id: string, decision: ApprovalDecision): void {
    const item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    item.resolve(decision);
    broadcast({ type: "approval.resolved", id, approved: decision.approved });
  }

  async function handleCommand(command: ClientCommand): Promise<unknown> {
    const payload = recordOf(command.payload);
    switch (command.type) {
      case "snapshot":
        return snapshot(optionalString(payload.selectedSessionId));
      case "session.select": {
        const sessionId = requiredString(payload.sessionId, "sessionId");
        const sessions = await backend.listSessions();
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        const messages = await backend.readHistory(sessionId, { limit: historyLimit });
        const messageCount = await backend.countHistory(sessionId);
        const jobs = await backend.listJobs(sessionId);
        const result: SelectResult = { session, messages, messageCount, jobs };
        return result;
      }
      case "session.create": {
        const model = optionalString(payload.model) ?? backend.listModels()[0]?.id;
        if (!model) throw new Error("no model is available");
        return backend.createSession(model);
      }
      case "session.restore":
        return backend.restoreSession(requiredString(payload.sessionId, "sessionId"));
      case "session.setModel": {
        const sessionId = requiredString(payload.sessionId, "sessionId");
        const model = requiredString(payload.model, "model");
        if (!backend.listModels().some((item) => item.id === model)) {
          throw new Error(`unknown model: ${model}`);
        }
        await backend.setModel(sessionId, model);
        const session = (await backend.listSessions()).find((item) => item.id === sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        return session;
      }
      case "session.setReasoning": {
        const sessionId = requiredString(payload.sessionId, "sessionId");
        const raw = payload.reasoning;
        let reasoning: ReasoningParams | undefined;
        if (raw !== null && raw !== undefined) {
          const value = recordOf(raw);
          const effort = optionalString(value.effort);
          const budgetTokens = optionalNumber(value.budgetTokens);
          if (
            effort !== undefined &&
            !["off", "low", "medium", "high", "max"].includes(effort)
          ) {
            throw new Error(`invalid reasoning effort: ${effort}`);
          }
          reasoning = {};
          if (effort !== undefined) {
            reasoning.effort = effort as NonNullable<ReasoningParams["effort"]>;
          }
          if (budgetTokens !== undefined) reasoning.budgetTokens = budgetTokens;
        }
        await backend.setReasoning(sessionId, reasoning);
        const session = (await backend.listSessions()).find((item) => item.id === sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        return session;
      }
      case "session.close":
        await backend.closeSession(requiredString(payload.sessionId, "sessionId"));
        return { closed: true };
      case "session.delete":
        await backend.deleteSession(requiredString(payload.sessionId, "sessionId"));
        return { deleted: true };
      case "session.send": {
        const sessionId = requiredString(payload.sessionId, "sessionId");
        const text = requiredString(payload.text, "text");
        const session = (await backend.listSessions()).find((item) => item.id === sessionId);
        if (!session) throw new Error(`session not found: ${sessionId}`);
        if (session.state === "closed" || session.state === "restoring") {
          throw new Error(`session is not accepting input: ${session.state}`);
        }
        void backend.send(sessionId, text).catch((error: unknown) => {
          backend.log("warn", `session.send failed: ${errorOf(error).message}`);
        });
        return { accepted: true };
      }
      case "session.cancel": {
        const sessionId = requiredString(payload.sessionId, "sessionId");
        await backend.cancel(sessionId);
        return { cancelled: true };
      }
      case "history.read": {
        const sessionId = requiredString(payload.sessionId, "sessionId");
        const before = optionalString(payload.before);
        const limit = optionalNumber(payload.limit);
        const options: { limit?: number; before?: string } = {};
        if (limit !== undefined) options.limit = limit;
        if (before !== undefined) options.before = before;
        const messages = await backend.readHistory(sessionId, options);
        const count = await backend.countHistory(sessionId);
        const result: HistoryReadResult = { messages, count };
        return result;
      }
      case "job.list":
        return backend.listJobs(
          requiredString(payload.sessionId, "sessionId"),
        );
      case "job.cancel":
        await backend.cancelJob(requiredString(payload.jobId, "jobId"));
        return { cancelled: true };
      case "job.read": {
        const offset = optionalNumber(payload.offset);
        const limit = optionalNumber(payload.limit);
        const options: JobReadOptions = {};
        if (offset !== undefined) options.offset = offset;
        if (limit !== undefined) options.limit = limit;
        return backend.readJob(requiredString(payload.jobId, "jobId"), options);
      }
      case "approval.respond": {
        const id = requiredString(payload.approvalId, "approvalId");
        if (!pending.has(id)) throw new Error(`approval not found: ${id}`);
        const approved = payload.approved === true;
        const reason = optionalString(payload.reason);
        resolveApproval(id, reason === undefined ? { approved } : { approved, reason });
        return { resolved: true };
      }
      default:
        throw new Error(`unknown command: ${command.type}`);
    }
  }

  async function handleRawCommand(socket: Socket, raw: string | Uint8Array): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      send(socket, { id: "", ok: false, error: { code: "invalid_json", message: "invalid JSON" } });
      return;
    }
    const value = recordOf(parsed);
    const id = typeof value.id === "string" ? value.id : "";
    const type = typeof value.type === "string" ? value.type : "";
    if (id.length === 0 || type.length === 0) {
      send(socket, { id, ok: false, error: { code: "invalid_command", message: "id and type are required" } });
      return;
    }
    const command: ClientCommand = { id, type };
    if ("payload" in value) command.payload = value.payload;
    try {
      const result = await handleCommand(command);
      send(socket, result === undefined ? { id, ok: true } : { id, ok: true, result });
    } catch (error) {
      send(socket, { id, ok: false, error: commandError(error) });
    }
  }

  async function ensureBundle(): Promise<string> {
    if (!bundlePromise) {
      bundlePromise = (async () => {
        const buildOptions = {
          entrypoints: [clientEntry],
          target: "browser",
          format: "esm",
          splitting: false,
          minify: true,
          write: false,
          sourcemap: "none",
        } as unknown as Parameters<typeof Bun.build>[0];
        const result = await Bun.build(buildOptions);
        if (!result.success) {
          throw new Error(result.logs.map((log) => log.message).join("\n"));
        }
        const output = result.outputs.find((item) => item.path.endsWith(".js")) ?? result.outputs[0];
        if (!output) throw new Error("client bundle produced no output");
        return await output.text();
      })().catch((error: unknown) => {
        bundlePromise = undefined;
        throw error;
      });
    }
    return bundlePromise;
  }

  function staticResponse(request: Request, path: string): Response | Promise<Response> {
    if (path === "/" || path === "/index.html") {
      return new Response(request.method === "HEAD" ? null : html, {
        headers: { ...securityHeaders(currentPort()), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/theme.css") {
      return new Response(request.method === "HEAD" ? null : themeCss, {
        headers: { ...securityHeaders(currentPort()), "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/styles.css") {
      return new Response(request.method === "HEAD" ? null : stylesCss, {
        headers: { ...securityHeaders(currentPort()), "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/app.js") {
      return ensureBundle().then(
        (bundle) =>
          new Response(request.method === "HEAD" ? null : bundle, {
            headers: {
              ...securityHeaders(currentPort()),
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-store",
            },
          }),
        (error: unknown) =>
          new Response(`client build failed: ${errorOf(error).message}`, {
            status: 500,
            headers: { ...securityHeaders(currentPort()), "Content-Type": "text/plain; charset=utf-8" },
          }),
      );
    }
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("not found", {
      status: 404,
      headers: { ...securityHeaders(currentPort()), "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  server = Bun.serve<SocketData>({
    hostname: host,
    port: requestedPort,
    development: false,
    fetch(request, srv): Response | Promise<Response> | undefined {
      const port = currentPort();
      if (!isAllowedHost(request.headers.get("host") ?? undefined, port)) {
        return new Response("forbidden host", { status: 403 });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD", ...securityHeaders(port) },
        });
      }
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
          return new Response("upgrade required", { status: 426 });
        }
        if (!isAllowedOrigin(request.headers.get("origin") ?? undefined, port)) {
          return new Response("forbidden origin", { status: 403 });
        }
        const upgraded = srv.upgrade(request, { data: { id: ++socketSeq } });
        if (upgraded) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return staticResponse(request, url.pathname);
    },
    websocket: {
      open(ws) {
        clients.add(ws as unknown as Socket);
        void snapshot()
          .then((data) => send(ws as unknown as Socket, { type: "snapshot", ...data }))
          .catch((error: unknown) => backend.log("warn", "snapshot failed", error));
      },
      message(ws, message) {
        void handleRawCommand(ws as unknown as Socket, message);
      },
      close(ws) {
        clients.delete(ws as unknown as Socket);
      },
    },
    error(error) {
      backend.log("error", "ui-web server error", error);
      return new Response("internal error", { status: 500 });
    },
  });

  function flushDeltasBefore(event: EventEnvelope): void {
    if (deltas.size === 0) return;
    const sameSession = [...deltas.values()].some((item) => item.event.sessionId === event.sessionId);
    if (sameSession || event.type === "turn.ended") flushDeltas();
  }

  unsubscribe = backend.onEvent((event) => {
    if (closing) return;
    if (event.type === "model.delta") {
      queueDelta(event);
      return;
    }
    flushDeltasBefore(event);
    broadcast({ type: "event", event });
  });

  const actualPort = server.port ?? requestedPort;
  const urlHost = host === "localhost" ? "localhost" : "127.0.0.1";
  const url = `http://${urlHost}:${actualPort}`;
  const loopback = host === "127.0.0.1" || host === "localhost";
  if (!loopback) {
    backend.log(
      "warn",
      `ui-web is listening on ${host}; Origin/Host are still limited to 127.0.0.1/localhost, so remote browsers will be rejected`,
    );
  }
  backend.log("info", `ui-web listening at ${url} (only loopback clients are accepted)`);

  return {
    host,
    port: actualPort,
    url,
    requestApproval(request) {
      if (closing) return Promise.resolve({ approved: false, reason: "ui-web is closing" });
      const id = `approval_${++approvalSeq}`;
      return new Promise<ApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          resolveApproval(id, { approved: false, reason: "approval timeout" });
        }, approvalTimeoutMs);
        pending.set(id, { request, resolve, timer });
        broadcast({ type: "approval.request", id, request });
        backend.log("info", `approval requested: ${request.module} (open ${url})`);
      });
    },
    close() {
      closing = true;
      if (deltaTimer !== undefined) clearTimeout(deltaTimer);
      deltaTimer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      for (const id of [...pending.keys()]) {
        resolveApproval(id, { approved: false, reason: "ui-web is closing" });
      }
      server?.stop(true);
      server = undefined;
      clients.clear();
    },
  };
}
