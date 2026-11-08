type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** モデル呼び出しの全体同時数を制限する。 */
export class Semaphore {
  #max: number;
  #active = 0;
  #waiters: Waiter[] = [];

  constructor(max: number) {
    this.#max = Math.max(1, Math.floor(max));
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    if (this.#active < this.#max) {
      this.#active += 1;
      return this.#releaseOnce();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active = Math.max(0, this.#active - 1);
      const next = this.#waiters.shift();
      if (!next) return;
      if (next.onAbort && next.signal) next.signal.removeEventListener("abort", next.onAbort);
      this.#active += 1;
      next.resolve(this.#releaseOnce());
    };
  }
}
