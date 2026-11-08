import { describe, expect, test } from "bun:test";
import { Semaphore } from "../../src/core/semaphore.ts";

describe("Semaphore", () => {
  test("queues acquisitions beyond the limit", async () => {
    const semaphore = new Semaphore(1);
    const release1 = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    let acquired = false;
    const second = semaphore.acquire().then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(acquired).toBe(false);
    expect(semaphore.pending).toBe(1);
    release1();
    const release2 = await second;
    expect(acquired).toBe(true);
    expect(semaphore.active).toBe(1);
    release2();
    expect(semaphore.active).toBe(0);
  });

  test("an aborted waiter is removed", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(semaphore.pending).toBe(0);
    release();
  });
});
