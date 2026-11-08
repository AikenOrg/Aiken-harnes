import type { Session } from "../protocol.ts";

export type SessionRow = {
  session: Session;
  depth: number;
};

export type EventFilter =
  | "all"
  | "session"
  | "turn"
  | "model"
  | "tool"
  | "job"
  | "agent"
  | "permission"
  | "module"
  | "other";

export const EVENT_FILTERS: Array<{ value: EventFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "session", label: "セッション" },
  { value: "turn", label: "ターン" },
  { value: "model", label: "モデル" },
  { value: "tool", label: "ツール" },
  { value: "job", label: "ジョブ" },
  { value: "agent", label: "エージェント" },
  { value: "permission", label: "権限" },
  { value: "module", label: "モジュール" },
  { value: "other", label: "その他" },
];

/** 親子関係を保ったまま、表示用の深さ付きフラット行にする。 */
export function flattenSessionTree(sessions: Session[]): SessionRow[] {
  const byParent = new Map<string | undefined, Session[]>();
  const known = new Set(sessions.map((session) => session.id));
  for (const session of sessions) {
    const parent = session.parentId !== undefined && known.has(session.parentId) ? session.parentId : undefined;
    const list = byParent.get(parent) ?? [];
    list.push(session);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }
  const roots = byParent.get(undefined) ?? [];
  roots.sort((a, b) => b.createdAt - a.createdAt);
  const rows: SessionRow[] = [];
  const visited = new Set<string>();
  const visit = (session: Session, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    rows.push({ session, depth });
    for (const child of byParent.get(session.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const session of sessions) {
    if (!visited.has(session.id)) visit(session, 0);
  }
  return rows;
}

export function sessionStateLabel(state: Session["state"]): string {
  switch (state) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "restoring":
      return "restoring";
    case "closed":
      return "closed";
    default:
      return "error";
  }
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("ja-JP", { hour12: false });
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 1) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function eventFilterGroup(type: string): EventFilter {
  if (type.startsWith("session.")) return "session";
  if (type.startsWith("turn.")) return "turn";
  if (type.startsWith("model.")) return "model";
  if (type.startsWith("tool.")) return "tool";
  if (type.startsWith("job.")) return "job";
  if (type.startsWith("agent.")) return "agent";
  if (type.startsWith("permission.")) return "permission";
  if (type.startsWith("module.")) return "module";
  return "other";
}

export function matchesEventFilter(type: string, filter: EventFilter): boolean {
  return filter === "all" || eventFilterGroup(type) === filter;
}

export function compactJson(value: unknown, max = 800): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

export function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
