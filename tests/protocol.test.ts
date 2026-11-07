import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  eventSchemas,
  type NotificationBlock,
  EXCLUSIVE_ROLES,
  addUsage,
  makeEventId,
  configSchema,
  type CoreEvent,
  type JobLimitError,
  type JobNotification,
  type ModuleManifest,
  type Provider,
  type Session,
} from "../src/protocol/index.ts";

describe("protocol", () => {
  test("event envelope carries seq and versioned payload", () => {
    const event: CoreEvent<"job.cancelled"> = {
      id: "evt_b00t_42",
      seq: 42,
      ts: 1_700_000_000_000,
      type: "job.cancelled",
      source: "core",
      sessionId: "ses_1",
      payload: { v: 1, jobId: "job_1", callId: "call_1", by: "user" },
    };

    expect(event.seq).toBe(42);
    expect(event.payload.v).toBe(1);
    expect(event.payload.by).toBe("user");
    expect(event.sessionId).toBe("ses_1");
    expect(event.id).toBe("evt_b00t_42");
    expect(makeEventId("b00t", 42)).toBe(event.id);
  });

  test("event schemas reject missing version and malformed errors", () => {
    expect(eventSchemas["job.cancelled"].safeParse({ jobId: "j", by: "ai" }).success).toBe(false);
    expect(
      eventSchemas["job.failed"].safeParse({
        v: 1,
        jobId: "j",
        callId: "c",
        tool: "shell",
        error: { code: "module_died", message: "boom" },
      }).success,
    ).toBe(true);
    expect(
      eventSchemas["job.failed"].safeParse({ v: 1, jobId: "j", callId: "c", tool: "shell", error: "boom" }).success,
    ).toBe(false);
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

  test("manifest declares roles and exclusive roles", () => {
    const manifest: ModuleManifest = {
      name: "sqlite",
      version: "0.1.0",
      roles: ["history-store", "session-store", "result-store"],
      critical: true,
      runner: "inprocess",
      main: "index.js",
      requires: ["provider"],
      talksTo: ["ui-web"],
      subscribes: ["message.appended", "history.rewritten"],
      permissions: [
        { cap: "history.read" },
        { cap: "history.restore" },
        { cap: "fs.write", paths: ["./data"] },
      ],
      tools: [{ name: "search_log", mode: "sync" }],
    };

    expect(manifest.roles).toContain("result-store");
    expect(manifest.permissions?.[2]?.paths).toEqual(["./data"]);
    expect(EXCLUSIVE_ROLES).toContain("shell");
    expect(EXCLUSIVE_ROLES).not.toContain("provider");
  });

  test("config uses one modules array and models.default", () => {
    const parsed = configSchema.parse({
      version: 1,
      modules: [
        "./modules/read.js",
        { use: "./modules/sqlite.js", config: { path: "./data/h.db" } },
      ],
      models: { default: "anthropic/claude" },
      restore: "last",
      context: { overflowRatio: 0.9 },
      shell: { mode: "whitelist", allow: ["git"] },
      jobs: {
        autoWake: true,
        maxConcurrentPerSession: 8,
        maxAutoWakeStreak: 10,
        maxSummaryChars: 200,
        maxNotificationChars: 2000,
      },
    });

    expect(parsed.modules).toHaveLength(2);
    expect(parsed.models.default).toBe("anthropic/claude");
    expect(parsed.restore).toBe("last");
    expect(parsed.context?.overflowRatio).toBe(0.9);
    expect(parsed.jobs?.autoWake).toBe(true);
    expect(parsed.jobs?.maxConcurrentPerSession).toBe(8);

    const tooLarge = configSchema.safeParse({
      version: 1,
      modules: [],
      models: { default: "x/y" },
      jobs: { maxSummaryChars: 501 },
    });
    expect(tooLarge.success).toBe(false);
  });

  test("provider interface and usage aggregation", async () => {
    const provider: Provider = {
      models: () => [{ id: "fake/model", provider: "fake", contextWindow: 128000 }],
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
      state: "restoring",
      model: "fake/model",
      autoWake: false,
      lastInputTokens: 1234,
      createdAt: 1,
    };

    expect("messages" in session).toBe(false);
    expect(session.lastInputTokens).toBe(1234);
  });
});

describe("event schema conventions", () => {
  test("every event payload carries v: 1", () => {
    for (const [type, schema] of Object.entries(eventSchemas)) {
      const shape = (schema as { shape: Record<string, unknown> }).shape;
      expect(`${type}:${"v" in shape}`).toBe(`${type}:true`);
    }
  });

  test("notification message batches entries in completion order", () => {
    const block: NotificationBlock = {
      type: "notification",
      entries: [
        { id: "job_1", status: "done", summary: "first", size: 10 },
        { id: "job_2", status: "failed", summary: "second", size: 0 },
      ],
    };

    expect(block.entries.map((entry) => entry.id)).toEqual(["job_1", "job_2"]);
  });
});

describe("job limits", () => {
  test("too_many_jobs carries running job ids", () => {
    const error: JobLimitError = {
      code: ERROR_CODES.tooManyJobs,
      message: "session job limit exceeded",
      runningJobIds: ["job_1", "job_2"],
    };

    expect(error.code).toBe("too_many_jobs");
    expect(error.runningJobIds).toHaveLength(2);
  });
});

describe("context overflow", () => {
  test("turn.ended can report context_overflow", () => {
    const parsed = eventSchemas["turn.ended"].safeParse({
      v: 1,
      turnId: "turn_1",
      reason: "context_overflow",
    });
    expect(parsed.success).toBe(true);
  });
});
