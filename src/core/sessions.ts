import type { EventBus } from "./bus.ts";
import type { IdGenerator } from "./ids.ts";
import type { Session, SessionState } from "../protocol/session.ts";
import type { ReasoningParams } from "../protocol/reasoning.ts";

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export type CreateSessionOptions = {
  model: string;
  parentId?: string;
  autoWake?: boolean;
  toolNames?: string[];
  reasoning?: ReasoningParams;
};

/** コアが最小限保持するセッション状態。履歴は HistoryManager が持つ。 */
export class SessionManager {
  #sessions = new Map<string, Session>();
  #bus: EventBus;
  #ids: IdGenerator;
  #defaultAutoWake: boolean;

  constructor(bus: EventBus, ids: IdGenerator, defaultAutoWake = false) {
    this.#bus = bus;
    this.#ids = ids;
    this.#defaultAutoWake = defaultAutoWake;
  }

  create(options: CreateSessionOptions): Session {
    const autoWake = options.autoWake ?? (options.parentId !== undefined ? true : this.#defaultAutoWake);
    const session: Session = {
      id: this.#ids.session(),
      state: "idle",
      model: options.model,
      autoWake,
      createdAt: Date.now(),
    };
    if (options.parentId !== undefined) session.parentId = options.parentId;
    if (options.toolNames !== undefined) session.toolNames = [...options.toolNames];
    if (options.reasoning !== undefined) session.reasoning = { ...options.reasoning };
    this.#sessions.set(session.id, session);

    const payload: {
      v: 1;
      model: string;
      autoWake: boolean;
      parentId?: string;
      reasoning?: ReasoningParams;
    } = {
      v: 1,
      model: session.model,
      autoWake,
    };
    if (session.parentId !== undefined) payload.parentId = session.parentId;
    if (session.reasoning !== undefined) payload.reasoning = session.reasoning;
    this.#bus.emit("session.created", payload, { source: "core", sessionId: session.id });
    return session;
  }

  /** 永続化モジュールが用意したセッションを、ID を保ったままコアへ戻す。 */
  restorePrepared(session: Session): Session {
    if (this.#sessions.has(session.id)) throw new Error(`session already exists: ${session.id}`);
    this.#sessions.set(session.id, session);
    return session;
  }

  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  get(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  tryGet(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  setState(sessionId: string, state: SessionState): void {
    this.get(sessionId).state = state;
  }

  setModel(sessionId: string, model: string): void {
    this.get(sessionId).model = model;
  }

  setReasoning(sessionId: string, reasoning?: ReasoningParams): Session {
    const session = this.get(sessionId);
    if (reasoning === undefined) delete session.reasoning;
    else session.reasoning = { ...reasoning };
    delete session.reasoningIgnored;
    this.#bus.emit(
      "session.reasoning",
      { v: 1, reasoning: reasoning ?? null },
      { source: "core", sessionId },
    );
    return session;
  }

  setReasoningIgnored(sessionId: string, ignored: string): void {
    const session = this.get(sessionId);
    if (ignored.length === 0) delete session.reasoningIgnored;
    else session.reasoningIgnored = ignored;
    this.#bus.emit(
      "session.reasoning",
      { v: 1, ignored },
      { source: "core", sessionId },
    );
  }

  setLastInputTokens(sessionId: string, inputTokens: number): void {
    this.get(sessionId).lastInputTokens = inputTokens;
  }

  /** 自分自身と子孫を返す。 */
  selfAndDescendants(sessionId: string): Session[] {
    const result: Session[] = [];
    const visit = (id: string): void => {
      const session = this.tryGet(id);
      if (!session) return;
      result.push(session);
      for (const child of this.#sessions.values()) {
        if (child.parentId === id) visit(child.id);
      }
    };
    visit(sessionId);
    return result;
  }

  isSelfOrDescendant(ancestorId: string, sessionId: string): boolean {
    let current = this.tryGet(sessionId);
    while (current) {
      if (current.id === ancestorId) return true;
      current = current.parentId ? this.tryGet(current.parentId) : undefined;
    }
    return false;
  }

  /** セッションと子孫を閉じる。 */
  close(sessionId: string, reason?: string): Session[] {
    const closing = this.selfAndDescendants(sessionId);
    for (const session of closing) {
      if (session.state === "closed") continue;
      session.state = "closed";
      const payload: { v: 1; reason?: string } = { v: 1 };
      if (reason !== undefined) payload.reason = reason;
      this.#bus.emit("session.closed", payload, { source: "core", sessionId: session.id });
    }
    return closing;
  }

  /**
   * closed のセッションだけを削除する。
   * 子孫が開いている場合は拒否する。一括削除 API は持たない。
   */
  delete(sessionId: string): void {
    const session = this.get(sessionId);
    if (session.state !== "closed") {
      throw new Error(`session must be closed before delete: ${sessionId}`);
    }
    const openDescendant = this.selfAndDescendants(sessionId).find(
      (candidate) => candidate.id !== sessionId && candidate.state !== "closed",
    );
    if (openDescendant) {
      throw new Error(`cannot delete ${sessionId}: descendant ${openDescendant.id} is not closed`);
    }
    this.#sessions.delete(sessionId);
    this.#bus.emit("session.deleted", { v: 1, sessionId }, { source: "core", sessionId });
  }
}
