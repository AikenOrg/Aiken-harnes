import type { EventEnvelope } from "../../../protocol/events.ts";
import type { Job, JobResult } from "../../../protocol/jobs.ts";
import type { Block, Message } from "../../../protocol/messages.ts";
import type { ReasoningCapability, ReasoningParams } from "../../../protocol/reasoning.ts";
import type { Session } from "../../../protocol/session.ts";
import {
  createButton,
  createDialog,
  createEmptyState,
  createLinearProgress,
  createList,
  createListItem,
  createStatusChip,
  createSwitch,
  createTabs,
  createTextField,
  h,
  type DialogHandle,
  type TextField,
  type TabsHandle,
} from "./components.ts";
import {
  compactJson,
  EVENT_FILTERS,
  eventFilterGroup,
  flattenSessionTree,
  formatClock,
  formatDuration,
  isNearBottom,
  matchesEventFilter,
  truncateText,
  type EventFilter,
} from "./state.ts";
import type {
  ClientCommand,
  CommandResponse,
  PendingApproval,
  SelectResult,
  ServerMessage,
  SnapshotData,
} from "../protocol.ts";

type AppState = {
  sessions: Session[];
  selectedId: string | undefined;
  messages: Message[];
  messageCount: number;
  jobs: Job[];
  restorable: Session[];
  models: Array<{ id: string; provider: string; reasoning?: ReasoningCapability }>;
  events: EventEnvelope[];
  deltas: Map<string, string>;
  reasoningDeltas: Map<string, string>;
  reasoningScroll: Map<string, { follow: boolean; top: number }>;
  showReasoning: boolean;
  approvals: PendingApproval[];
  tab: "jobs" | "events";
  filter: EventFilter;
  connected: boolean;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const state: AppState = {
  sessions: [],
  selectedId: undefined,
  messages: [],
  messageCount: 0,
  jobs: [],
  restorable: [],
  models: [],
  events: [],
  deltas: new Map(),
  reasoningDeltas: new Map(),
  reasoningScroll: new Map(),
  showReasoning: (() => {
    try {
      const stored = localStorage.getItem("ui.showReasoning");
      return stored === null ? true : stored === "1";
    } catch {
      return true;
    }
  })(),
  approvals: [],
  tab: "jobs",
  filter: "all",
  connected: false,
};

const app = document.getElementById("app");
if (!app) throw new Error("#app is missing");

let ws: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let commandSeq = 0;
const pendingCommands = new Map<string, PendingCommand>();
let historyTimer: ReturnType<typeof setTimeout> | undefined;
let jobsTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let approvalDialog: DialogHandle | undefined;
let approvalId: string | undefined;
let tabs: TabsHandle | undefined;

// --- layout ---------------------------------------------------------------

const connectionChip = h("span", { class: "connection-chip disconnected", text: "disconnected" });
const sessionTree = h("div", { class: "session-tree" });
const newButton = createButton("新規", { variant: "filled", onClick: () => void createSession() });
const restoreButton = createButton("復元", { variant: "outlined", onClick: () => openRestoreDialog() });
const closeButton = createButton("閉じる", { variant: "text", onClick: () => void closeSelected() });
const deleteButton = createButton("削除", { variant: "text", onClick: () => void deleteSelected() });

const headerInfo = h("div", { class: "conversation-title" });
const headerProgress = h("div", { class: "conversation-progress" });
const messagesEl = h("div", { class: "messages", role: "log", "aria-live": "polite" });
const composerField: TextField = createTextField({
  label: "メッセージ",
  placeholder: "Enter で送信 / Shift+Enter で改行",
  multiline: true,
  rows: 2,
  onKeyDown: (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendCurrent();
    }
  },
});
const sendButton = createButton("送信", { variant: "filled", onClick: () => void sendCurrent() });
const cancelButton = createButton("キャンセル", { variant: "outlined", onClick: () => void cancelSelected() });
const composer = h(
  "div",
  { class: "composer" },
  composerField,
  h("div", { class: "composer-actions" }, cancelButton, sendButton),
);
const sideContent = h("div", { class: "side-content" });
const toastEl = h("div", { class: "toast", role: "status" });
const dialogRoot = h("div", { id: "dialog-root" });

const shell = h(
  "div",
  { class: "app-shell" },
  h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark", text: "NH" }), h("span", { text: "next-harness" })),
    h("div", { class: "topbar-meta" }, connectionChip),
  ),
  h(
    "aside",
    { class: "sessions-pane" },
    h("div", { class: "pane-head" }, h("h1", { text: "セッション" })),
    h("div", { class: "session-toolbar" }, newButton, restoreButton, closeButton, deleteButton),
    sessionTree,
  ),
  h(
    "main",
    { class: "conversation-pane" },
    h("div", { class: "conversation-head" }, headerInfo, headerProgress),
    messagesEl,
    composer,
  ),
  h("aside", { class: "side-pane" }),
  toastEl,
  dialogRoot,
);
app.append(shell);

tabs = createTabs(["ジョブ", "イベント"], 0, (index) => {
  state.tab = index === 0 ? "jobs" : "events";
  renderSide();
});
shell.querySelector(".side-pane")?.append(tabs.element, sideContent);

// --- commands -------------------------------------------------------------

function command<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("not connected"));
      return;
    }
    const id = `cmd_${++commandSeq}`;
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`command timed out: ${type}`));
    }, 10_000);
    pendingCommands.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    const message: ClientCommand = { id, type };
    if (payload !== undefined) message.payload = payload;
    ws.send(JSON.stringify(message));
  });
}

function toast(message: string, isError = false): void {
  toastEl.textContent = message;
  toastEl.className = `toast show${isError ? " error" : ""}`;
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, 4_000);
}

function setButtonDisabled(button: HTMLElement, disabled: boolean): void {
  (button as HTMLElement & { disabled: boolean }).disabled = disabled;
}

// --- rendering ------------------------------------------------------------

function selectedSession(): Session | undefined {
  return state.sessions.find((session) => session.id === state.selectedId);
}

function renderConnection(): void {
  connectionChip.textContent = state.connected ? "connected" : "reconnecting";
  connectionChip.className = `connection-chip ${state.connected ? "connected" : "disconnected"}`;
}

function renderToolbar(): void {
  const session = selectedSession();
  setButtonDisabled(newButton, state.models.length === 0);
  setButtonDisabled(restoreButton, state.restorable.length === 0);
  setButtonDisabled(closeButton, session === undefined || session.state === "closed");
  setButtonDisabled(deleteButton, session === undefined || session.state !== "closed");
}

function renderSessions(): void {
  sessionTree.replaceChildren();
  const rows = flattenSessionTree(state.sessions);
  if (rows.length === 0) {
    sessionTree.append(createEmptyState("セッションがありません。「新規」で開始してください。"));
    renderToolbar();
    return;
  }
  const list = createList("session-list");
  for (const row of rows) {
    const session = row.session;
    const trailing = createStatusChip(session.state);
    const item = createListItem({
      headline: shortenId(session.id),
      supportingText: session.model,
      selected: session.id === state.selectedId,
      indent: row.depth * 16,
      trailing,
      onClick: () => void selectSession(session.id),
    });
    item.title = session.id;
    list.append(item);
  }
  sessionTree.append(list);
  renderToolbar();
}

function shortenId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 17)}…` : id;
}

function modelControls(session: Session): Node[] {
  if (state.models.length === 0) {
    return [h("span", { class: "muted", text: session.model })];
  }
  const select = h("select", { class: "m3-select model-select", "aria-label": "モデル" });
  const models = [...state.models].sort((a, b) => a.id.localeCompare(b.id));
  if (!models.some((item) => item.id === session.model)) {
    models.unshift({ id: session.model, provider: "" });
  }
  for (const item of models) {
    const option = h("option", { value: item.id, text: item.id });
    if (item.id === session.model) option.selected = true;
    select.append(option);
  }
  select.value = session.model;
  select.addEventListener("change", () => {
    const model = select.value;
    void command<Session>("session.setModel", { sessionId: session.id, model })
      .then((updated) => {
        upsertSession(updated);
        renderAll();
        toast("モデルを変更しました（次のターンから）");
      })
      .catch((error: unknown) => toast(errorText(error), true));
  });
  return [
    h(
      "label",
      { class: "model-control" },
      h("span", { class: "muted", text: "model" }),
      select,
    ),
  ];
}

function reasoningControls(session: Session): Node[] {
  const nodes: Node[] = [];
  const toggle = createSwitch("reasoning を表示", state.showReasoning, (value) => {
    state.showReasoning = value;
    try {
      localStorage.setItem("ui.showReasoning", value ? "1" : "0");
    } catch {
      // ignore
    }
    renderMessages();
  });
  nodes.push(toggle.element);

  const ignoredWarning =
    session.reasoningIgnored !== undefined && session.reasoningIgnored.length > 0
      ? h("span", {
          class: "reasoning-warning",
          title: session.reasoningIgnored,
          text: "指定は無視されました",
        })
      : undefined;
  const model = state.models.find((item) => item.id === session.model);
  const capability = model?.reasoning;
  if (capability?.supported !== true) {
    nodes.push(h("span", { class: "muted", text: "reasoning 非対応" }));
    if (ignoredWarning) nodes.push(ignoredWarning);
    return nodes;
  }
  const options: string[] = ["", "off"];
  for (const effort of capability.efforts ?? []) {
    if (effort !== "off" && !options.includes(effort)) options.push(effort);
  }
  if ((capability.efforts === undefined || capability.efforts.length === 0) && capability.toggle === true) {
    options.push("medium");
  }
  const select = h("select", { class: "m3-select reasoning-select", "aria-label": "reasoning の強度" });
  for (const effort of options) {
    const label =
      effort === ""
        ? "既定"
        : effort === "medium" && (capability.efforts === undefined || capability.efforts.length === 0)
          ? "on (medium)"
          : effort;
    const option = h("option", { value: effort, text: label });
    select.append(option);
  }
  const current = session.reasoning?.effort ?? "";
  if (current.length > 0 && !options.includes(current)) options.push(current);
  select.value = current;
  select.addEventListener("change", () => {
    const value = select.value;
    const reasoning: ReasoningParams | null =
      value === "" ? null : { effort: value as NonNullable<ReasoningParams["effort"]> };
    void command<Session>("session.setReasoning", { sessionId: session.id, reasoning })
      .then((updated) => {
        upsertSession(updated);
        renderHeader();
        renderSessions();
      })
      .catch((error: unknown) => toast(errorText(error), true));
  });
  nodes.push(
    h("label", { class: "reasoning-control" }, h("span", { class: "muted", text: "reasoning" }), select),
  );
  if (ignoredWarning) nodes.push(ignoredWarning);
  return nodes;
}

function renderHeader(): void {
  headerInfo.replaceChildren();
  headerProgress.replaceChildren();
  const session = selectedSession();
  if (!session) {
    headerInfo.append(h("span", { class: "muted", text: "セッションを選択してください" }));
    return;
  }
  headerInfo.append(
    h("span", { class: "conversation-id", text: session.id }),
    createStatusChip(session.state),
    h("span", { class: "muted", text: `${state.messageCount} messages` }),
  );
  headerInfo.append(...modelControls(session), ...reasoningControls(session));
  if (session.state === "active") headerProgress.append(createLinearProgress());
}

function messageRoleLabel(role: Message["role"]): string {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    case "notification":
      return "notification";
    default:
      return "system";
  }
}

function blockNode(block: Block): Node {
  switch (block.type) {
    case "text": {
      const text = h("div", { class: "text-block" });
      text.textContent = block.text;
      return text;
    }
    case "reasoning": {
      if (!state.showReasoning) return h("span", { class: "hidden" });
      const hasText = block.text.length > 0;
      const details = h("details", { class: "block reasoning" });
      details.append(
        h("summary", { text: hasText ? "reasoning" : "reasoning (redacted)" }),
        ...(hasText ? [h("pre", { class: "reasoning-text", text: block.text })] : []),
      );
      return details;
    }
    case "tool_call": {
      const details = h("details", { class: "block tool-call" });
      details.append(
        h("summary", { text: `tool_call: ${block.name}` }),
        h("pre", { text: compactJson(block.args) }),
      );
      return details;
    }
    case "tool_result": {
      const details = h("details", { class: `block tool-result${block.isError ? " error" : ""}` });
      details.append(
        h("summary", { text: `tool_result: ${block.name}${block.isError ? " (error)" : ""}` }),
        h("pre", { text: block.content }),
      );
      return details;
    }
    case "notification": {
      const details = h("details", { class: "block notification" });
      const list = h("div", { class: "notification-list" });
      for (const entry of block.entries) {
        list.append(
          h(
            "div",
            { class: "notification-entry" },
            h("span", { text: entry.id }),
            h("span", { class: "muted", text: `${entry.status} · ${entry.size} bytes` }),
            h("span", { text: truncateText(entry.summary, 200) }),
          ),
        );
      }
      details.append(h("summary", { text: `notification (${block.entries.length})` }), list);
      return details;
    }
    default:
      return h("div", { text: "unknown block" });
  }
}

function loadOlder(): void {
  const session = selectedSession();
  const first = state.messages[0];
  if (!session || !first) return;
  void (async () => {
    try {
      const result = await command<{ messages: Message[]; count: number }>("history.read", {
        sessionId: session.id,
        limit: 200,
        before: first.id,
      });
      if (result.messages.length === 0) {
        toast("これより前の履歴はありません");
        return;
      }
      state.messages = [...result.messages, ...state.messages];
      state.messageCount = result.count;
      renderMessages();
    } catch (error) {
      toast(errorText(error), true);
    }
  })();
}

function renderMessages(): void {
  const nearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
  const sessionForScroll = selectedSession();
  const existingReasoning = messagesEl.querySelector<HTMLElement>(
    ".reasoning.streaming .reasoning-text",
  );
  if (sessionForScroll && existingReasoning) {
    const memory = state.reasoningScroll.get(sessionForScroll.id) ?? {
      follow: true,
      top: 0,
    };
    memory.top = existingReasoning.scrollTop;
    memory.follow = isNearBottom(existingReasoning);
    state.reasoningScroll.set(sessionForScroll.id, memory);
  }
  messagesEl.replaceChildren();
  const session = selectedSession();
  if (!session) {
    messagesEl.append(createEmptyState("セッションを選択してください。"));
    return;
  }
  if (state.messages.length === 0 && !state.deltas.has(session.id)) {
    messagesEl.append(createEmptyState("まだメッセージはありません。"));
  }
  if (state.messages.length > 0 && state.messageCount > state.messages.length) {
    messagesEl.append(
      h(
        "div",
        { class: "load-older" },
        createButton("以前の履歴を読み込む", { variant: "text", onClick: loadOlder }),
      ),
    );
  }
  for (const message of state.messages) {
    const article = h("article", { class: `message role-${message.role}` });
    const meta = h(
      "div",
      { class: "message-meta" },
      h("span", { class: "message-role", text: messageRoleLabel(message.role) }),
      h("span", { class: "muted", text: formatClock(message.createdAt) }),
    );
    if (message.interrupted === true) {
      meta.append(h("span", { class: "interrupted", text: "interrupted" }));
    }
    if (message.truncated === true) {
      meta.append(h("span", { class: "truncated", text: "truncated (length)" }));
    }
    article.append(meta);
    for (const block of message.blocks) article.append(blockNode(block));
    messagesEl.append(article);
  }
  const reasoningDelta = state.reasoningDeltas.get(session.id);
  if (state.showReasoning && reasoningDelta !== undefined && reasoningDelta.length > 0) {
    const details = h("details", { class: "block reasoning streaming", open: true });
    const pre = h("pre", { class: "reasoning-text", text: reasoningDelta });
    const memory = state.reasoningScroll.get(session.id) ?? { follow: true, top: 0 };
    pre.addEventListener("scroll", () => {
      memory.top = pre.scrollTop;
      memory.follow = isNearBottom(pre);
      state.reasoningScroll.set(session.id, memory);
    });
    details.append(h("summary", { text: "reasoning (streaming)" }), pre);
    messagesEl.append(details);
    pre.scrollTop = memory.follow ? pre.scrollHeight : memory.top;
  }
  const delta = state.deltas.get(session.id);
  if (delta !== undefined && delta.length > 0) {
    const article = h("article", { class: "message role-assistant streaming" });
    article.append(
      h(
        "div",
        { class: "message-meta" },
        h("span", { class: "message-role", text: "assistant" }),
        h("span", { class: "muted", text: "streaming" }),
      ),
      h("div", { class: "text-block" }, h("span", { text: delta }), h("span", { class: "cursor" })),
    );
    messagesEl.append(article);
  }
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderComposer(): void {
  const session = selectedSession();
  const disabled = session === undefined || session.state === "closed";
  composerField.disabled = disabled;
  setButtonDisabled(sendButton, disabled);
  setButtonDisabled(cancelButton, session === undefined || session.state !== "active");
}

function jobCard(job: Job): HTMLElement {
  const card = h("div", { class: "job-card" });
  const head = h(
    "div",
    { class: "job-head" },
    createStatusChip(job.status),
    h("span", { class: "job-tool", text: job.tool }),
    h("span", { class: "muted", text: formatDuration((job.endedAt ?? Date.now()) - job.createdAt) }),
  );
  card.append(head);
  card.append(h("div", { class: "job-id", text: `${job.id} · ${job.callId}` }));
  if (job.summary !== undefined && job.summary.length > 0) {
    card.append(h("div", { class: "job-summary", text: truncateText(job.summary, 240) }));
  }
  const actions = h("div", { class: "job-actions" });
  if (job.status === "running") {
    actions.append(
      createButton("キャンセル", {
        variant: "text",
        onClick: () => void cancelJob(job.id),
      }),
    );
  } else {
    actions.append(
      createButton("結果", {
        variant: "outlined",
        onClick: () => void showJobResult(job),
      }),
    );
  }
  card.append(actions);
  return card;
}

function renderJobs(): void {
  sideContent.replaceChildren();
  sideContent.append(h("div", { class: "side-head" }, h("h2", { text: "ジョブ" })));
  if (state.jobs.length === 0) {
    sideContent.append(createEmptyState("このセッションのジョブはありません。"));
    return;
  }
  const list = h("div", { class: "job-list" });
  for (const job of [...state.jobs].sort((a, b) => b.createdAt - a.createdAt)) list.append(jobCard(job));
  sideContent.append(list);
}

function renderEvents(): void {
  sideContent.replaceChildren();
  const select = h("select", { class: "m3-select", "aria-label": "イベントの種別" });
  for (const option of EVENT_FILTERS) {
    const node = h("option", { value: option.value, text: option.label });
    if (option.value === state.filter) node.selected = true;
    select.append(node);
  }
  select.addEventListener("change", () => {
    state.filter = select.value as EventFilter;
    renderEvents();
  });
  sideContent.append(h("div", { class: "side-head" }, h("h2", { text: "イベント" }), select));
  const events = state.events.filter((event) => matchesEventFilter(event.type, state.filter));
  if (events.length === 0) {
    sideContent.append(createEmptyState("該当するイベントはありません。"));
    return;
  }
  const list = h("div", { class: "event-list" });
  for (const event of events.slice(0, 300)) {
    const details = h("details", { class: `event-row group-${eventFilterGroup(event.type)}` });
    details.append(
      h(
        "summary",
        {},
        h("span", { class: "event-seq", text: `#${event.seq}` }),
        h("span", { class: "event-type", text: event.type }),
        h("span", { class: "muted", text: event.sessionId ?? "" }),
      ),
      h("pre", { text: compactJson(event.payload) }),
    );
    list.append(details);
  }
  sideContent.append(list);
}

function renderSide(): void {
  tabs?.setActive(state.tab === "jobs" ? 0 : 1);
  if (state.tab === "jobs") renderJobs();
  else renderEvents();
}

function renderAll(): void {
  renderConnection();
  renderSessions();
  renderHeader();
  renderMessages();
  renderComposer();
  renderSide();
  renderToolbar();
}

// --- state changes --------------------------------------------------------

function upsertSession(session: Session): void {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) state.sessions[index] = session;
  else state.sessions.push(session);
}

function applySnapshot(data: SnapshotData, resetEvents: boolean): void {
  state.sessions = data.sessions;
  state.selectedId = data.selectedSessionId;
  state.messages = data.messages;
  state.messageCount = data.messageCount;
  state.jobs = data.jobs;
  state.restorable = data.restorable;
  state.models = data.models.map((model) => ({
    id: model.id,
    provider: model.provider,
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
  }));
  state.approvals = data.approvals;
  state.deltas.clear();
  state.reasoningDeltas.clear();
  state.reasoningScroll.clear();
  if (resetEvents) state.events = [];
  renderAll();
  showNextApproval();
}

async function refreshSnapshot(): Promise<void> {
  if (!state.connected) return;
  const payload = state.selectedId !== undefined ? { selectedSessionId: state.selectedId } : {};
  const data = await command<SnapshotData>("snapshot", payload);
  applySnapshot(data, false);
}

async function selectSession(sessionId: string): Promise<void> {
  state.selectedId = sessionId;
  state.messages = [];
  state.jobs = [];
  state.messageCount = 0;
  state.deltas.delete(sessionId);
  state.reasoningDeltas.delete(sessionId);
  state.reasoningScroll.delete(sessionId);
  renderAll();
  try {
    const result = await command<SelectResult>("session.select", { sessionId });
    if (state.selectedId !== sessionId) return;
    upsertSession(result.session);
    state.messages = result.messages;
    state.messageCount = result.messageCount;
    state.jobs = result.jobs;
    renderAll();
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function createSession(): Promise<void> {
  const model = selectedSession()?.model ?? state.models[0]?.id;
  if (!model) {
    toast("利用できるモデルがありません", true);
    return;
  }
  try {
    const session = await command<Session>("session.create", { model });
    upsertSession(session);
    await refreshSnapshot();
    await selectSession(session.id);
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function closeSelected(): Promise<void> {
  const session = selectedSession();
  if (!session || session.state === "closed") return;
  if (!window.confirm(`セッション ${session.id} を閉じますか？`)) return;
  try {
    await command("session.close", { sessionId: session.id });
    upsertSession({ ...session, state: "closed" });
    await refreshSnapshot();
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function deleteSelected(): Promise<void> {
  const session = selectedSession();
  if (!session || session.state !== "closed") return;
  if (!window.confirm(`セッション ${session.id} を削除しますか？`)) return;
  try {
    await command("session.delete", { sessionId: session.id });
    state.sessions = state.sessions.filter((item) => item.id !== session.id);
    state.selectedId = undefined;
    state.messages = [];
    state.jobs = [];
    state.messageCount = 0;
    await refreshSnapshot();
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function sendCurrent(): Promise<void> {
  const session = selectedSession();
  const text = composerField.value.trim();
  if (!session || text.length === 0 || session.state === "closed") return;
  composerField.value = "";
  state.messages.push({
    id: `local_${Date.now()}`,
    role: "user",
    blocks: [{ type: "text", text }],
    createdAt: Date.now(),
  });
  renderMessages();
  try {
    await command("session.send", { sessionId: session.id, text });
  } catch (error) {
    toast(errorText(error), true);
    scheduleHistory();
  }
}

async function cancelSelected(): Promise<void> {
  const session = selectedSession();
  if (!session) return;
  try {
    await command("session.cancel", { sessionId: session.id });
    toast("現在のターンをキャンセルしました");
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function cancelJob(jobId: string): Promise<void> {
  try {
    await command("job.cancel", { jobId });
    scheduleJobs();
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function showJobResult(job: Job): Promise<void> {
  try {
    const result = await command<JobResult>("job.read", { jobId: job.id, limit: 100_000 });
    const dialog = createDialog();
    dialog.setContent({
      headline: `ジョブ結果: ${job.tool}`,
      supportingText: `${result.status} · ${result.size} bytes${result.truncated ? " (truncated)" : ""}`,
      body: h("pre", { class: "result-pre", text: result.content }),
      actions: [createButton("閉じる", { variant: "text", onClick: () => dialog.close() })],
    });
    dialog.onClosed = () => dialog.element.remove();
    dialogRoot.append(dialog.element);
    dialog.open();
  } catch (error) {
    toast(errorText(error), true);
  }
}

function openRestoreDialog(): void {
  if (state.restorable.length === 0) {
    toast("復元できるセッションがありません", true);
    return;
  }
  const dialog = createDialog();
  const list = createList("restore-list");
  for (const session of state.restorable) {
    list.append(
      createListItem({
        headline: session.id,
        supportingText: `${session.model} · ${new Date(session.createdAt).toLocaleString("ja-JP")}`,
        onClick: () => {
          dialog.close();
          void restoreSession(session.id);
        },
      }),
    );
  }
  dialog.setContent({
    headline: "セッションを復元",
    body: list,
    actions: [createButton("キャンセル", { variant: "text", onClick: () => dialog.close() })],
  });
  dialog.onClosed = () => dialog.element.remove();
  dialogRoot.append(dialog.element);
  dialog.open();
}

async function restoreSession(sessionId: string): Promise<void> {
  try {
    const session = await command<Session>("session.restore", { sessionId });
    upsertSession(session);
    await refreshSnapshot();
    await selectSession(session.id);
    toast("セッションを復元しました");
  } catch (error) {
    toast(errorText(error), true);
  }
}

// --- approvals ------------------------------------------------------------

function removeApproval(id: string): void {
  state.approvals = state.approvals.filter((item) => item.id !== id);
}

function showNextApproval(): void {
  if (approvalDialog !== undefined) return;
  const next = state.approvals[0];
  if (!next) return;
  approvalId = next.id;
  const request = next.request;
  const body = h("div", { class: "approval-body" });
  body.append(h("p", { text: `${request.module}@${request.version}` }));
  body.append(h("p", { class: "muted", text: `roles: ${request.roles.join(", ") || "(none)"}` }));
  const permissions = h("ul", { class: "approval-list" });
  for (const permission of request.permissions) permissions.append(h("li", { text: permission }));
  body.append(h("h3", { text: "権限" }), permissions);
  if (request.changes.length > 0) {
    const changes = h("ul", { class: "approval-list" });
    for (const change of request.changes) changes.append(h("li", { text: change }));
    body.append(h("h3", { text: "変更" }), changes);
  }
  if (request.warnings.length > 0) {
    const warnings = h("ul", { class: "approval-list warning" });
    for (const warning of request.warnings) warnings.append(h("li", { text: warning }));
    body.append(h("h3", { text: "警告" }), warnings);
  }
  const dialog = createDialog();
  dialog.setContent({
    headline: "モジュール承認",
    supportingText: "このモジュールに権限を付与しますか？",
    body,
    actions: [
      createButton("拒否", { variant: "text", onClick: () => void respondApproval(false) }),
      createButton("承認", { variant: "filled", onClick: () => void respondApproval(true) }),
    ],
  });
  dialog.onClosed = () => {
    const dismissedId = approvalId;
    approvalDialog = undefined;
    approvalId = undefined;
    dialog.element.remove();
    if (dismissedId !== undefined && state.approvals.some((item) => item.id === dismissedId)) {
      removeApproval(dismissedId);
      void command("approval.respond", {
        approvalId: dismissedId,
        approved: false,
        reason: "dismissed",
      }).catch(() => undefined);
    }
    showNextApproval();
  };
  approvalDialog = dialog;
  dialogRoot.append(dialog.element);
  dialog.open();
}

async function respondApproval(approved: boolean): Promise<void> {
  const id = approvalId;
  if (id === undefined) return;
  removeApproval(id);
  approvalDialog?.close();
  try {
    await command("approval.respond", { approvalId: id, approved });
  } catch (error) {
    toast(errorText(error), true);
  }
}

// --- event handling -------------------------------------------------------

function scheduleHistory(): void {
  if (state.selectedId === undefined) return;
  if (historyTimer !== undefined) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    void (async () => {
      const sessionId = state.selectedId;
      if (sessionId === undefined) return;
      try {
        const result = await command<{ messages: Message[]; count: number }>("history.read", {
          sessionId,
          limit: 200,
        });
        if (state.selectedId !== sessionId) return;
        state.messages = result.messages;
        state.messageCount = result.count;
        state.deltas.delete(sessionId);
        state.reasoningDeltas.delete(sessionId);
        state.reasoningScroll.delete(sessionId);
        renderMessages();
        renderHeader();
      } catch {
        // 一時的な切断中は無視し、再接続の snapshot で回復する
      }
    })();
  }, 80);
}

function scheduleJobs(): void {
  if (state.selectedId === undefined) return;
  if (jobsTimer !== undefined) clearTimeout(jobsTimer);
  jobsTimer = setTimeout(() => {
    void (async () => {
      const sessionId = state.selectedId;
      if (sessionId === undefined) return;
      try {
        const jobs = await command<Job[]>("job.list", { sessionId });
        if (state.selectedId !== sessionId) return;
        state.jobs = jobs;
        if (state.tab === "jobs") renderJobs();
      } catch {
        // snapshot で回復する
      }
    })();
  }, 120);
}

function setSessionState(sessionId: string | undefined, next: Session["state"]): void {
  if (sessionId === undefined) return;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  session.state = next;
}

function handleEvent(event: EventEnvelope): void {
  if (event.type !== "model.delta") {
    state.events.unshift(event);
    if (state.events.length > 500) state.events.length = 500;
  }
  const sessionId = event.sessionId;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "session.created": {
      if (sessionId && !state.sessions.some((item) => item.id === sessionId)) {
        const created: Session = {
          id: sessionId,
          state: "idle",
          model: typeof payload.model === "string" ? payload.model : "",
          createdAt: event.ts,
        };
        if (typeof payload.parentId === "string") created.parentId = payload.parentId;
        if (typeof payload.autoWake === "boolean") created.autoWake = payload.autoWake;
        state.sessions.push(created);
        renderSessions();
      }
      break;
    }
    case "session.closed": {
      setSessionState(sessionId, "closed");
      renderSessions();
      renderHeader();
      renderComposer();
      break;
    }
    case "session.deleted": {
      if (sessionId) {
        state.sessions = state.sessions.filter((item) => item.id !== sessionId);
        if (state.selectedId === sessionId) {
          state.selectedId = undefined;
          state.messages = [];
          state.jobs = [];
          state.messageCount = 0;
        }
        renderAll();
      }
      break;
    }
    case "session.restored": {
      setSessionState(sessionId, "idle");
      renderSessions();
      renderHeader();
      // 起動時の auto-restore は接続後に起きるため、snapshot を取り直して木へ追加する。
      if (state.connected) void refreshSnapshot().catch(() => undefined);
      break;
    }
    case "session.model": {
      if (sessionId !== undefined) {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (session && typeof payload.model === "string") {
          session.model = payload.model;
          delete session.reasoningIgnored;
          renderHeader();
          renderSessions();
        }
      }
      break;
    }
    case "session.reasoning": {
      if (sessionId !== undefined) {
        const session = state.sessions.find((item) => item.id === sessionId);
        if (session) {
          if (payload.reasoning === null) delete session.reasoning;
          else if (payload.reasoning !== undefined) {
            session.reasoning = payload.reasoning as ReasoningParams;
          }
          if (typeof payload.ignored === "string") {
            if (payload.ignored.length > 0) session.reasoningIgnored = payload.ignored;
            else delete session.reasoningIgnored;
          }
          renderHeader();
          renderSessions();
        }
      }
      break;
    }
    case "turn.started": {
      setSessionState(sessionId, "active");
      if (sessionId !== undefined && sessionId === state.selectedId) {
        state.deltas.set(sessionId, "");
        state.reasoningDeltas.set(sessionId, "");
        state.reasoningScroll.set(sessionId, { follow: true, top: 0 });
      }
      renderSessions();
      renderHeader();
      renderComposer();
      if (sessionId !== undefined && sessionId === state.selectedId) renderMessages();
      break;
    }
    case "turn.ended": {
      setSessionState(sessionId, "idle");
      if (payload.reason === "length") {
        toast("出力がトークン上限に達しました（truncated）", true);
      }
      renderSessions();
      renderHeader();
      renderComposer();
      if (sessionId !== undefined && sessionId === state.selectedId) scheduleHistory();
      break;
    }
    case "model.delta": {
      if (sessionId !== undefined && sessionId === state.selectedId) {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (payload.kind === "reasoning") {
          state.reasoningDeltas.set(sessionId, (state.reasoningDeltas.get(sessionId) ?? "") + text);
        } else {
          state.deltas.set(sessionId, (state.deltas.get(sessionId) ?? "") + text);
        }
        renderMessages();
      }
      break;
    }
    case "message.appended":
    case "tool.completed":
    case "tool.failed": {
      if (sessionId !== undefined && sessionId === state.selectedId) scheduleHistory();
      break;
    }
    case "job.running":
    case "job.done":
    case "job.failed":
    case "job.cancelled":
    case "job.notified": {
      if (sessionId !== undefined && sessionId === state.selectedId) scheduleJobs();
      break;
    }
    case "core.stopping": {
      toast("ハーネスを停止しています");
      break;
    }
    case "model.failed": {
      const error = payload.error as { message?: string } | undefined;
      if (error?.message) toast(error.message, true);
      break;
    }
    case "permission.denied": {
      const module = typeof payload.module === "string" ? payload.module : "module";
      toast(`権限が拒否されました: ${module}`, true);
      break;
    }
    default:
      break;
  }
  if (event.type !== "model.delta" && state.tab === "events") renderEvents();
}

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "snapshot":
      state.connected = true;
      applySnapshot(message, true);
      break;
    case "event":
      handleEvent(message.event);
      break;
    case "approval.request": {
      if (!state.approvals.some((item) => item.id === message.id)) {
        state.approvals.push({ id: message.id, request: message.request });
      }
      showNextApproval();
      break;
    }
    case "approval.resolved": {
      removeApproval(message.id);
      if (approvalId === message.id) approvalDialog?.close();
      break;
    }
  }
}

function handleCommandResponse(response: CommandResponse): void {
  const pending = pendingCommands.get(response.id);
  if (!pending) return;
  pendingCommands.delete(response.id);
  clearTimeout(pending.timer);
  if (response.ok) pending.resolve(response.result);
  else pending.reject(new Error(response.error.message));
}

function handleSocketMessage(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const value = parsed as Record<string, unknown>;
  if (typeof value.id === "string" && typeof value.ok === "boolean") {
    handleCommandResponse(parsed as CommandResponse);
    return;
  }
  if (typeof value.type === "string") handleServerMessage(parsed as ServerMessage);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- connection -----------------------------------------------------------

function connect(): void {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.addEventListener("open", () => {
    state.connected = true;
    renderConnection();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") handleSocketMessage(event.data);
  });
  ws.addEventListener("close", () => {
    state.connected = false;
    renderConnection();
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error("connection closed"));
      pendingCommands.delete(id);
    }
    if (!shuttingDown) {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1_000);
    }
  });
  ws.addEventListener("error", () => {
    // close ハンドラで再接続する
  });
}

window.addEventListener("beforeunload", () => {
  shuttingDown = true;
  ws?.close();
});

renderAll();
connect();
