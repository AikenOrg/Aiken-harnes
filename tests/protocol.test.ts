import { describe, expect, test } from "bun:test";
import type {
  CoreEvent,
  JobNotification,
  ModuleManifest,
  Provider,
  Session,
} from "../src/protocol/index.ts";
import { addUsage } from "../src/protocol/index.ts";

describe("protocol", () => {
  test("event envelope carries seq and typed payload", () => {
    const event: CoreEvent<"job.cancelled"> = {
      id: "evt_42",
      seq: 42,
      ts: 1_700_000_000_000,
      type: "job.cancelled",
      source: "core",
      sessionId: "ses_1",
      payload: { jobId: "job_1", by: "user" },
    };

    expect(event.seq).toBe(42);
    expect(event.payload.by).toBe("user");
    expect(event.sessionId).toBe("ses_1");
  });

  test("job notification is the fixed four-field JSON", () => {
    const notification: JobNotification = {
      id: "job_1",
      status: "done",
      summary: "listed 12 files",
      size: 340,
    };

    expect(Object.keys(notification).sort()).toEqual(["id", "size", "status", "summary"]);
  });

  test("manifest declares roles and permissions", () => {
    const manifest: ModuleManifest = {
      name: "log-sqlite",
      version: "0.1.0",
      roles: ["history-store", "observer"],
      critical: true,
      runner: "inprocess",
      requires: ["session-store"],
      talksTo: ["ui-web"],
      subscribes: ["message.appended", "tool.*"],
      permissions: [
        { cap: "history.read" },
        { cap: "fs.write", paths: ["./data"] },
      ],
      tools: [{ name: "search_log", mode: "sync" }],
    };

    expect(manifest.roles).toContain("history-store");
    expect(manifest.permissions?.[1]?.paths).toEqual(["./data"]);
  });

  test("provider interface and usage aggregation", async () => {
    const provider: Provider = {
      models: () => [{ id: "fake/model", provider: "fake" }],
      async *stream() {
        yield { type: "text", delta: "hi" } as const;
        yield { type: "usage", input: 1, output: 2 } as const;
        yield { type: "stop", reason: "end" } as const;
      },
    };

    const events = [];
    for await (const event of provider.stream(
      { model: "fake/model", system: [], messages: [], tools: [] },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(addUsage({ input: 1, output: 2 }, { input: 3, output: 4, cacheRead: 5 })).toEqual({
      input: 4,
      output: 6,
      cacheRead: 5,
    });
  });

  test("session keeps only minimal state", () => {
    const session: Session = {
      id: "ses_1",
      parentId: "ses_0",
      state: "idle",
      model: "fake/model",
      createdAt: 1,
    };

    expect("messages" in session).toBe(false);
  });
});
