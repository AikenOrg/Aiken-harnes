import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { Message } from "../../src/protocol/messages.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";
import { providerModule, ScriptedProvider } from "../core/helpers.ts";

const tempDirs: string[] = [];

function config(): HarnessConfig {
  return { version: 1, modules: [], models: { default: "mock/script" } };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-harness-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function storeModule(db: string): Promise<ModuleDefinition> {
  const definition = await loadModuleDefinition("./src/modules/store-sqlite", process.cwd());
  definition.config = { path: db, ttlDays: 30, cleanupIntervalMs: 3_600_000 };
  return definition;
}

function provider(): ScriptedProvider {
  return new ScriptedProvider([
    { text: "hello response", usage: { input: 10, output: 2 }, stop: "end" },
    { text: "continued", usage: { input: 20, output: 1 }, stop: "end" },
  ]);
}

async function makeHarness(db: string, idsPrefix: string): Promise<Harness> {
  return new Harness({
    config: config(),
    modules: [providerModule(provider()), await storeModule(db)],
    autoApprove: true,
    ids: createSequentialIds(idsPrefix),
  });
}

describe("store-sqlite", () => {
  test("round-trips messages including interrupted markers", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "save");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    const interrupted = h1.history.append(session.id, {
      role: "assistant",
      blocks: [{ type: "text", text: "partial" }],
      interrupted: true,
    });
    const before = h1.history.read(session.id);
    await h1.flushPersistence();
    await h1.stop();

    const h2 = await makeHarness(db, "load");
    await h2.start();
    const restorable = await h2.listRestorable();
    expect(restorable.map((item) => item.id)).toContain(session.id);
    const restored = await h2.restoreSession(session.id);
    expect(restored.state).toBe("idle");
    const after = h2.history.read(session.id);
    expect(after).toEqual(before);
    expect(after.find((message) => message.id === interrupted.id)?.interrupted).toBe(true);
    await h2.stop();
  });

  test("rejects history.restore on a non-restoring session", async () => {
    const dir = await tempDir();
    const h = await makeHarness(join(dir, "harness.sqlite"), "reject");
    await h.start();
    const session = h.createSession();
    await h.send(session.id, "hello");
    const existing = h.history.read(session.id);
    expect(() => h.history.restore(session.id, existing)).toThrow();
    await h.stop();
  });

  test("persists history.rewritten", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "rewrite1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    const replacement: Message = {
      id: "msg_replacement",
      role: "user",
      blocks: [{ type: "text", text: "rewritten" }],
      createdAt: 123,
    };
    h1.history.rewrite(session.id, [replacement], "test rewrite");
    await h1.flushPersistence();
    await h1.stop();

    const h2 = await makeHarness(db, "rewrite2");
    await h2.start();
    await h2.restoreSession(session.id);
    expect(h2.history.read(session.id)).toEqual([replacement]);
    await h2.stop();
  });

  test("session.delete cascades messages and job results", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "delete1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    const job = h1.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "call_delete",
      tool: "slow",
      module: "tools-slow",
    });
    h1.jobs.done(job.job.id, "tools-slow", { summary: "done", result: "body" });
    await h1.flushPersistence();
    await h1.stop();

    const h2 = await makeHarness(db, "delete2");
    await h2.start();
    await h2.restoreSession(session.id);
    h2.closeSession(session.id);
    await h2.deleteSession(session.id);
    await h2.flushPersistence();
    await h2.stop();

    const raw = new Database(db, { readonly: true });
    expect((raw.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    expect((raw.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);
    expect((raw.query("SELECT COUNT(*) AS n FROM job_results").get() as { n: number }).n).toBe(0);
    raw.close();
  });

  test("TTL cleanup removes only terminal notified rows", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "ttl1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    const finished = h1.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "c1",
      tool: "slow",
      module: "tools-slow",
    });
    h1.jobs.done(finished.job.id, "tools-slow", { summary: "old", result: "old" });
    const unnotified = h1.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "c2",
      tool: "slow",
      module: "tools-slow",
    });
    h1.jobs.done(unnotified.job.id, "tools-slow", { summary: "new", result: "new" });
    const running = h1.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "c3",
      tool: "slow",
      module: "tools-slow",
    });
    await h1.flushPersistence();
    await h1.stop();

    const h2 = await makeHarness(db, "ttl2");
    await h2.start();

    const raw = new Database(db);
    raw.query("UPDATE job_results SET notified = 1, finished_at = 1 WHERE job_id = ?").run(finished.job.id);
    raw.query("UPDATE job_results SET notified = 0, finished_at = 1 WHERE job_id = ?").run(running.job.id);
    raw.query("UPDATE job_results SET notified = 0, finished_at = 1 WHERE job_id = ?").run(unnotified.job.id);
    raw.close();

    const deleted = await h2.modules.callRole<number>("result-store", "deleteExpired", { ttlDays: 30 });
    expect(deleted).toBe(1);
    const remaining = await h2.modules.callRole<Array<{ id: string }>>("result-store", "listBySession", {
      sessionId: session.id,
    });
    expect(remaining.map((job) => job.id).sort()).toEqual([running.job.id, unnotified.job.id].sort());
    await h2.stop();
  });

  test("restores running jobs as interrupted and requeues unnotified notifications exactly once", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "jobs1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    await h1.flushPersistence();
    await h1.stop();

    const raw = new Database(db);
    raw
      .query(
        "INSERT INTO job_results (job_id, session_id, call_id, tool, status, notified, summary, size, result, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("job_running", session.id, "c_running", "slow", "running", 1, null, null, null, null, Date.now(), null);
    raw
      .query(
        "INSERT INTO job_results (job_id, session_id, call_id, tool, status, notified, summary, size, result, error_code, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("job_done", session.id, "c_done", "slow", "done", 0, "old", 3, new TextEncoder().encode("old"), null, Date.now(), Date.now());
    raw.close();

    const h2 = await makeHarness(db, "jobs2");
    await h2.start();
    await h2.restoreSession(session.id);
    expect(h2.jobs.get("job_running")?.status).toBe("failed");
    expect(h2.jobs.get("job_running")?.summary).toBe("interrupted");
    expect(h2.jobs.pendingNotifications(session.id).map((job) => job.id)).toEqual(["job_done"]);
    expect((await h2.jobs.readResult("job_done", session.id)).content).toBe("old");

    await h2.send(session.id, "continue");
    const firstNotifications = h2.history
      .read(session.id)
      .filter((message) => message.role === "notification");
    expect(firstNotifications).toHaveLength(1);
    const entries = firstNotifications[0]?.blocks[0];
    expect(entries?.type).toBe("notification");
    if (entries?.type === "notification") {
      expect(entries.entries.map((entry) => entry.id)).toContain("job_done");
    }

    await h2.send(session.id, "again");
    const secondNotifications = h2.history
      .read(session.id)
      .filter((message) => message.role === "notification");
    expect(secondNotifications).toHaveLength(1);
    await h2.stop();
  });

  test("aborts startup when the database cannot be opened", async () => {
    const dir = await tempDir();
    const dbPath = join(dir, "not-a-file");
    await mkdir(dbPath);
    const h = await makeHarness(dbPath, "broken");
    await expect(h.start()).rejects.toThrow();
  });

  test("restores history/session without a result-store but loses job state", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "noresult1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    const job = h1.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "c",
      tool: "slow",
      module: "tools-slow",
    });
    h1.jobs.done(job.job.id, "tools-slow", { summary: "done", result: "body" });
    await h1.flushPersistence();
    await h1.stop();

    const noResultStore = await storeModule(db);
    noResultStore.manifest.roles = ["history-store", "session-store"];
    const h2 = new Harness({
      config: config(),
      modules: [providerModule(provider()), noResultStore],
      autoApprove: true,
      ids: createSequentialIds("noresult2"),
    });
    await h2.start();
    await h2.restoreSession(session.id);
    expect(h2.history.count(session.id)).toBeGreaterThan(0);
    expect(h2.jobs.listJobs(session.id)).toHaveLength(0);
    expect(h2.jobs.pendingNotifications(session.id)).toHaveLength(0);
    await h2.stop();
  });

  test("serializes 10 x 1,000 concurrent appends without loss or reordering", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h = await makeHarness(db, "load");
    await h.start();
    const sessions = Array.from({ length: 10 }, () => h.createSession());
    for (const session of sessions) {
      for (let index = 0; index < 1_000; index += 1) {
        h.history.append(session.id, {
          role: "user",
          blocks: [{ type: "text", text: `m${index}` }],
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.flushPersistence();
    await h.stop();

    const raw = new Database(db, { readonly: true });
    const total = (raw.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    expect(total).toBe(10_000);
    for (const session of sessions) {
      const stats = raw
        .query("SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM messages WHERE session_id = ?")
        .get(session.id) as { n: number; lo: number; hi: number };
      expect(stats).toEqual({ n: 1_000, lo: 1, hi: 1_000 });
    }
    raw.close();
  });

  test("restore: last automatically loads the latest session", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "autolast1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    await h1.flushPersistence();
    await h1.stop();

    const h2 = new Harness({
      config: { ...config(), restore: "last" },
      modules: [providerModule(provider()), await storeModule(db)],
      autoApprove: true,
      ids: createSequentialIds("autolast2"),
    });
    await h2.start();
    expect(h2.sessions.tryGet(session.id)?.state).toBe("idle");
    expect(h2.history.count(session.id)).toBeGreaterThan(0);
    await h2.stop();
  });

  test("marks wait-delivered jobs as notified in persistence", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "wait1");
    await h1.start();
    const session = h1.createSession();
    const job = h1.jobs.create({
      sessionId: session.id,
      ownerSessionId: session.id,
      callId: "wait",
      tool: "slow",
      module: "tools-slow",
    });
    h1.jobs.done(job.job.id, "tools-slow", { summary: "done", result: "body" });
    await h1.jobs.wait([job.job.id], 100, session.id);
    await h1.flushPersistence();
    await h1.stop();

    const h2 = await makeHarness(db, "wait2");
    await h2.start();
    await h2.restoreSession(session.id);
    expect(h2.jobs.get(job.job.id)?.status).toBe("done");
    expect(h2.jobs.pendingNotifications(session.id)).toHaveLength(0);
    await h2.stop();
  });

  test("restore failure sets error and allows retry", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const h1 = await makeHarness(db, "retry1");
    await h1.start();
    const session = h1.createSession();
    await h1.send(session.id, "hello");
    await h1.flushPersistence();
    await h1.stop();

    const raw = new Database(db);
    raw.query("UPDATE messages SET content_json = '{broken' WHERE session_id = ?").run(session.id);
    raw.close();

    const h2 = await makeHarness(db, "retry2");
    await h2.start();
    await expect(h2.restoreSession(session.id)).rejects.toThrow();
    expect(h2.sessions.get(session.id).state).toBe("error");

    const repair = new Database(db);
    repair.query("UPDATE messages SET content_json = '[]' WHERE session_id = ?").run(session.id);
    repair.close();
    const restored = await h2.restoreSession(session.id);
    expect(restored.state).toBe("idle");
    await h2.stop();
  });

  test("unknown schema version aborts startup", async () => {
    const dir = await tempDir();
    const db = join(dir, "harness.sqlite");
    const raw = new Database(db);
    raw.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (999);");
    raw.close();
    const h = await makeHarness(db, "schema");
    await expect(h.start()).rejects.toThrow(/unknown store-sqlite schema version/);
  });
});
