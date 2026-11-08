import type { ApprovalRequest } from "../../protocol/approval.ts";
import type { EventEnvelope } from "../../protocol/events.ts";
import type { Job, JobResult, JobStatus } from "../../protocol/jobs.ts";
import type { Message } from "../../protocol/messages.ts";
import type { ModelInfo } from "../../protocol/provider.ts";
import type { Session } from "../../protocol/session.ts";

export type UiWebConfig = {
  host?: string;
  port?: number;
  seedColor?: string;
  approvalTimeoutMs?: number;
  historyLimit?: number;
};

export type PendingApproval = {
  id: string;
  request: ApprovalRequest;
};

export type SnapshotData = {
  sessions: Session[];
  selectedSessionId?: string;
  messages: Message[];
  messageCount: number;
  jobs: Job[];
  restorable: Session[];
  models: ModelInfo[];
  approvals: PendingApproval[];
};

export type SelectResult = {
  session: Session;
  messages: Message[];
  messageCount: number;
  jobs: Job[];
};

export type ServerMessage =
  | ({ type: "snapshot" } & SnapshotData)
  | { type: "event"; event: EventEnvelope }
  | { type: "approval.request"; id: string; request: ApprovalRequest }
  | { type: "approval.resolved"; id: string; approved: boolean };

export type ClientCommand = {
  id: string;
  type: string;
  payload?: unknown;
};

export type CommandError = {
  code: string;
  message: string;
};

export type CommandResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: CommandError };

export type JobReadOptions = {
  offset?: number;
  limit?: number;
};

export type HistoryReadResult = {
  messages: Message[];
  count: number;
};

/** payload を安全に読むための小さな補助。 */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function statusOf(value: unknown): JobStatus | undefined {
  return value === "running" || value === "done" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}

export type { Job, JobResult, JobStatus, Message, ModelInfo, Session };
