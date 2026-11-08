import type { ApprovalDecision, ApprovalRequest } from "../../protocol/approval.ts";
import type { ModuleContext, ModuleExports } from "../../protocol/ctx.ts";
import type { UiWebConfig } from "./protocol.ts";
import { createUiServer, type UiBackend, type UiServerHandle } from "./server.ts";

const methods: Record<string, (...args: unknown[]) => unknown> = {};
let server: UiServerHandle | undefined;

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function configOf(raw: Record<string, unknown>): UiWebConfig {
  const config: UiWebConfig = {};
  if (typeof raw.host === "string" && raw.host.length > 0) config.host = raw.host;
  if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65_535) {
    config.port = raw.port;
  }
  if (typeof raw.seedColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.seedColor)) {
    config.seedColor = raw.seedColor;
  }
  if (raw.approvalTimeoutMs !== undefined) {
    config.approvalTimeoutMs = positiveInteger(raw.approvalTimeoutMs, 300_000);
  }
  if (raw.historyLimit !== undefined) {
    config.historyLimit = positiveInteger(raw.historyLimit, 200);
  }
  return config;
}

function backendOf(ctx: ModuleContext): UiBackend {
  return {
    listSessions: () => ctx.session.list(),
    listRestorable: () => ctx.session.listRestorable(),
    listModels: () => ctx.session.models(),
    readHistory: (sessionId, options) => ctx.history.read(sessionId, options),
    countHistory: (sessionId) => ctx.history.count(sessionId),
    listJobs: (sessionId, status) => ctx.jobs.list(sessionId, status),
    createSession: (model) => ctx.session.create({ model }),
    restoreSession: (sessionId) => ctx.session.restore(sessionId),
    closeSession: (sessionId) => ctx.session.close(sessionId),
    deleteSession: (sessionId) => ctx.session.delete(sessionId),
    send: (sessionId, text) => ctx.session.send(sessionId, text),
    cancel: (sessionId) => ctx.session.cancel(sessionId),
    cancelJob: (jobId) => ctx.jobs.cancel(jobId),
    readJob: (jobId, options) => ctx.jobs.read(jobId, options),
    onEvent: (handler) => ctx.bus.on("*", handler),
    log: (level, message, meta) => ctx.log[level](message, meta),
  };
}

const module: ModuleExports = {
  init(ctx, rawConfig) {
    server = createUiServer(backendOf(ctx), configOf(rawConfig));
  },
  dispose() {
    server?.close();
    server = undefined;
  },
  methods,
};

methods.requestApproval = async (value: unknown): Promise<ApprovalDecision> => {
  if (!server) return { approved: false, reason: "ui-web server is not running" };
  return server.requestApproval(value as ApprovalRequest);
};

methods.info = () => {
  if (!server) return undefined;
  return { host: server.host, port: server.port, url: server.url };
};

export default module;
export const init = module.init;
export const dispose = module.dispose;
export const methodTable = methods;
