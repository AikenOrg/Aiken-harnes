/**
 * OpenCode Go の実 API 検証。キーは ~/.config/iken-harnes/.env 等から読み込む。
 * 課金が発生するため、明示的に実行したときだけ動かす。
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { configSchema } from "../src/protocol/config.ts";
import type { EventEnvelope } from "../src/protocol/events.ts";
import type { ModuleDefinition } from "../src/core/module-host.ts";
import { Harness } from "../src/core/harness.ts";
import { loadModuleDefinition } from "../src/core/module-loader.ts";
import { loadUserEnv } from "../src/core/user-env.ts";

const CONFIG = "config/opencode-go.config.json";

async function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  await loadUserEnv();
  const configPath = resolve(CONFIG);
  const config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const definitions: ModuleDefinition[] = [];
  for (const entry of config.modules) {
    const use = typeof entry === "string" ? entry : entry.use;
    const definition = await loadModuleDefinition(use, dirname(configPath));
    const explicit = typeof entry === "string" ? undefined : entry.config;
    if (definition.manifest.roles.includes("shell") && config.shell !== undefined) {
      definition.config = { ...config.shell, ...(explicit ?? {}) };
    } else if (explicit !== undefined) {
      definition.config = explicit;
    }
    definitions.push(definition);
  }

  const harness = new Harness({ config, modules: definitions, autoApprove: true });
  const events: EventEnvelope[] = [];
  harness.on("*", (event) => events.push(event));
  await harness.start();

  const results: Record<string, unknown> = {};

  try {
    // 1. cancel by ai for a long shell.
    {
      const session = harness.createSession();
      let cancelledJob: string | undefined;
      const off = harness.on("job.running", (event) => {
        if (event.sessionId !== session.id) return;
        const payload = event.payload as { jobId?: string };
        if (payload.jobId) {
          cancelledJob = payload.jobId;
          harness.jobs.cancel(payload.jobId, "ai", "verification cancel");
        }
      });
      await timeout(
        harness.send(session.id, "Use the shell tool with command `sleep 30`. Do not call wait. Reply with: scheduled."),
        60_000,
        "cancel.send",
      );
      off();
      const job = cancelledJob ? harness.jobs.get(cancelledJob) : undefined;
      const cancelledEvent = events.find(
        (event) => event.type === "job.cancelled" && (event.payload as { jobId?: string }).jobId === cancelledJob,
      );
      results.cancel = {
        jobId: cancelledJob,
        status: job?.status,
        by: (cancelledEvent?.payload as { by?: string } | undefined)?.by,
        ok: job?.status === "cancelled" && (cancelledEvent?.payload as { by?: string } | undefined)?.by === "ai",
      };
    }

    // 2. completion notification without wait.
    {
      const session = harness.createSession();
      await timeout(
        harness.send(session.id, "Use the shell tool with command `echo notify-check`. Do not call wait. Reply with: started."),
        60_000,
        "notify.send",
      );
      const job = harness.jobs.listJobs(session.id).find((candidate) => candidate.tool === "shell");
      if (job) {
        const deadline = Date.now() + 20_000;
        while (job.status === "running" && Date.now() < deadline) await sleep(100);
      }
      const notificationBefore = harness.history
        .read(session.id)
        .some((message) => message.role === "notification");
      if (!notificationBefore) {
        await timeout(harness.send(session.id, "Continue and report any notification you received."), 60_000, "notify.continue");
      }
      const notification = harness.history
        .read(session.id)
        .find((message) => message.role === "notification");
      results.notification = {
        jobStatus: job?.status,
        found: notification !== undefined,
        entries: notification?.blocks[0]?.type === "notification" ? notification.blocks[0].entries : undefined,
        ok: notification !== undefined,
      };
    }

    // 3. cancel mid-stream and keep interrupted partial text.
    {
      const session = harness.createSession();
      let cancelled = false;
      const off = harness.on("model.delta", (event) => {
        if (event.sessionId !== session.id || cancelled) return;
        cancelled = true;
        harness.cancel(session.id, "user", "verification stream cancel");
      });
      await timeout(
        harness.send(session.id, "Write a 500 word story about a robot. Do not use tools."),
        60_000,
        "stream-cancel.send",
      );
      off();
      const assistant = harness.history
        .read(session.id)
        .find((message) => message.role === "assistant");
      const ended = events.find(
        (event) =>
          event.type === "turn.ended" &&
          event.sessionId === session.id &&
          (event.payload as { reason?: string }).reason === "cancelled",
      );
      results.streamCancel = {
        sawDelta: cancelled,
        interrupted: assistant?.interrupted,
        partial: assistant?.blocks[0]?.type === "text" ? assistant.blocks[0].text.slice(0, 40) : undefined,
        turnCancelled: ended !== undefined,
        ok: cancelled && assistant?.interrupted === true && ended !== undefined,
      };
    }

    // 4. context overflow without calling the model.
    {
      const session = harness.createSession();
      harness.sessions.setLastInputTokens(session.id, 2_000_000);
      const before = events.length;
      await timeout(harness.send(session.id, "This should not be sent."), 30_000, "overflow.send");
      const overflow = events
        .slice(before)
        .find(
          (event) =>
            event.type === "turn.ended" &&
            event.sessionId === session.id &&
            (event.payload as { reason?: string }).reason === "context_overflow",
        );
      const calledModel = events
        .slice(before)
        .some((event) => event.type === "model.requested" && event.sessionId === session.id);
      results.contextOverflow = { overflow: overflow !== undefined, calledModel, ok: overflow !== undefined && !calledModel };
    }
  } finally {
    await harness.stop();
  }

  console.log(JSON.stringify(results, null, 2));
  const ok = Object.values(results).every((value) => (value as { ok?: boolean }).ok === true);
  process.exitCode = ok ? 0 : 1;
}

await main();
