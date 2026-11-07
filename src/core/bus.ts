import type { EventEnvelope } from "../protocol/events.ts";
import { makeEventId } from "../protocol/events.ts";

export type EventHandler = (event: EventEnvelope) => void;
export type EventErrorHandler = (error: unknown, event: EventEnvelope) => void;

type Subscription = {
  pattern: string;
  handler: EventHandler;
  once: boolean;
};

export function eventMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export type EventBusOptions = {
  bootId: string;
  now?: () => number;
  onError?: EventErrorHandler;
};

/** seq の採番と購読者への発行順を保証するイベントバス。 */
export class EventBus {
  readonly bootId: string;
  #seq = 0;
  #subscriptions: Subscription[] = [];
  #now: () => number;
  #onError: EventErrorHandler | undefined;

  constructor(options: EventBusOptions) {
    this.bootId = options.bootId;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError;
  }

  get seq(): number {
    return this.#seq;
  }

  emit<TType extends string, TPayload>(
    type: TType,
    payload: TPayload,
    options: { source: string; sessionId?: string },
  ): EventEnvelope<TType, TPayload> {
    const seq = ++this.#seq;
    const event: EventEnvelope<TType, TPayload> = {
      id: makeEventId(this.bootId, seq),
      seq,
      ts: this.#now(),
      type,
      source: options.source,
      payload,
    };
    if (options.sessionId !== undefined) event.sessionId = options.sessionId;

    for (const subscription of [...this.#subscriptions]) {
      if (!eventMatches(subscription.pattern, type)) continue;
      if (subscription.once) this.#remove(subscription);
      try {
        subscription.handler(event);
      } catch (error) {
        this.#onError?.(error, event);
      }
    }
    return event;
  }

  on(pattern: string, handler: EventHandler): () => void {
    const subscription: Subscription = { pattern, handler, once: false };
    this.#subscriptions.push(subscription);
    return () => this.#remove(subscription);
  }

  once(pattern: string, handler: EventHandler): () => void {
    const subscription: Subscription = { pattern, handler, once: true };
    this.#subscriptions.push(subscription);
    return () => this.#remove(subscription);
  }

  removeAll(): void {
    this.#subscriptions = [];
  }

  #remove(subscription: Subscription): void {
    const index = this.#subscriptions.indexOf(subscription);
    if (index >= 0) this.#subscriptions.splice(index, 1);
  }
}
