import type { EventBus } from "./bus.ts";
import type { IdGenerator } from "./ids.ts";
import type { SessionManager } from "./sessions.ts";
import type { Message, NewMessage } from "../protocol/messages.ts";

export type ReadOptions = {
  limit?: number;
  before?: string;
};

/** 実行中履歴の唯一の正。永続化モジュールは message.appended を購読する投影。 */
export class HistoryManager {
  #messages = new Map<string, Message[]>();
  #bus: EventBus;
  #ids: IdGenerator;
  #sessions: SessionManager;
  #now: () => number;

  constructor(bus: EventBus, ids: IdGenerator, sessions: SessionManager, now?: () => number) {
    this.#bus = bus;
    this.#ids = ids;
    this.#sessions = sessions;
    this.#now = now ?? (() => Date.now());
  }

  append(sessionId: string, message: NewMessage): Message {
    this.#sessions.get(sessionId);
    const stored: Message = {
      id: this.#ids.message(),
      role: message.role,
      blocks: message.blocks,
      createdAt: this.#now(),
    };
    if (message.interrupted !== undefined) stored.interrupted = message.interrupted;
    this.#messagesFor(sessionId).push(stored);
    this.#bus.emit("message.appended", { v: 1, messageId: stored.id }, { source: "core", sessionId });
    return stored;
  }

  appendBatch(sessionId: string, messages: NewMessage[]): Message[] {
    this.#sessions.get(sessionId);
    const list = this.#messagesFor(sessionId);
    const stored = messages.map((message): Message => {
      const item: Message = {
        id: this.#ids.message(),
        role: message.role,
        blocks: message.blocks,
        createdAt: this.#now(),
      };
      if (message.interrupted !== undefined) item.interrupted = message.interrupted;
      return item;
    });
    list.push(...stored);
    for (const item of stored) {
      this.#bus.emit("message.appended", { v: 1, messageId: item.id }, { source: "core", sessionId });
    }
    return stored;
  }

  get(sessionId: string, messageId: string): Message | undefined {
    return this.#messagesFor(sessionId).find((message) => message.id === messageId);
  }

  read(sessionId: string, options?: ReadOptions): Message[] {
    const list = this.#messagesFor(sessionId);
    let end = list.length;
    if (options?.before !== undefined) {
      const index = list.findIndex((message) => message.id === options.before);
      if (index >= 0) end = index;
    }
    const start = options?.limit !== undefined ? Math.max(0, end - options.limit) : 0;
    return list.slice(start, end);
  }

  count(sessionId: string): number {
    return this.#messagesFor(sessionId).length;
  }

  /**
   * 保存済み履歴をコアへ戻す。restoring かつ空のセッションだけ。
   */
  restore(sessionId: string, messages: Message[]): void {
    const session = this.#sessions.get(sessionId);
    if (session.state !== "restoring") {
      throw new Error(`session ${sessionId} is not restoring`);
    }
    if (this.#messagesFor(sessionId).length > 0) {
      throw new Error(`session ${sessionId} already has history`);
    }
    this.#messages.set(sessionId, [...messages]);
    void session;
  }

  rewrite(sessionId: string, messages: Message[], reason: string): void {
    const before = this.count(sessionId);
    this.#messages.set(sessionId, [...messages]);
    this.#bus.emit(
      "history.rewritten",
      { v: 1, reason, beforeCount: before, afterCount: messages.length },
      { source: "core", sessionId },
    );
  }

  deleteSession(sessionId: string): void {
    this.#messages.delete(sessionId);
  }

  #messagesFor(sessionId: string): Message[] {
    let list = this.#messages.get(sessionId);
    if (!list) {
      list = [];
      this.#messages.set(sessionId, list);
    }
    return list;
  }
}
