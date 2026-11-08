import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { configSchema } from "./protocol/config.ts";
import type { EventEnvelope } from "./protocol/events.ts";
import { CORE_VERSION } from "./protocol/version.ts";
import { Harness } from "./core/harness.ts";
import { Logger } from "./core/log.ts";
import { approveAllAllowed } from "./core/approvals.ts";
import { loadUserEnv } from "./core/user-env.ts";
import { loadModuleDefinition } from "./core/module-loader.ts";
import type { ModuleDefinition } from "./core/module-host.ts";

export * from "./protocol/index.ts";
export * from "./core/index.ts";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envFile = argValue(args, "--env-file") ?? process.env.HARNESS_ENV_FILE;
  await loadUserEnv(envFile);
  const configPath = argValue(args, "--config") ?? process.env.HARNESS_CONFIG;
  if (!configPath) {
    console.log(`Aiken-harnes ${CORE_VERSION}`);
    console.log("usage: bun run src/index.ts --config <config.json> [--approve-all] [--events] [--show-reasoning] [--env-file <path>] [--approvals <path>]");
    return;
  }

  const absoluteConfig = resolve(configPath);
  const config = configSchema.parse(JSON.parse(await readFile(absoluteConfig, "utf8")));
  const approveAll = args.includes("--approve-all");
  if (approveAll && !approveAllAllowed(config)) {
    console.error("--approve-all is disabled by config.allowApproveAll=false");
    process.exitCode = 1;
    return;
  }
  if (approveAll) {
    console.warn("WARNING: --approve-all bypasses module approvals. Nothing will be written to approvals.json.");
  }
  const definitions: ModuleDefinition[] = [];
  for (const entry of config.modules) {
    const use = typeof entry === "string" ? entry : entry.use;
    const definition = await loadModuleDefinition(use, dirname(absoluteConfig));
    const explicit = typeof entry === "string" ? undefined : entry.config;
    if (definition.manifest.roles.includes("shell") && config.shell !== undefined) {
      definition.config = { ...config.shell, ...(explicit ?? {}) };
    } else if (explicit !== undefined) {
      definition.config = explicit;
    }
    definitions.push(definition);
  }
  if (!definitions.some((definition) => definition.manifest.roles.includes("ui"))) {
    definitions.push(
      await loadModuleDefinition(join(import.meta.dir, "modules/ui-cli"), import.meta.dir),
    );
  }
  const uiOwner = definitions.find((definition) => definition.manifest.roles.includes("ui"));
  const headless = uiOwner !== undefined && uiOwner.manifest.name !== "ui-cli";

  const approvalsPath = argValue(args, "--approvals");
  const harness = new Harness({
    config,
    modules: definitions,
    ...(approveAll ? { autoApprove: true } : {}),
    ...(approvalsPath !== undefined ? { approvalsPath } : {}),
    logger: new Logger({
      ...(config.log?.level !== undefined ? { level: config.log.level } : {}),
    }),
  });

  const showReasoning = args.includes("--show-reasoning");
  harness.on("model.delta", (event) => {
    const payload = event.payload as { text?: string; kind?: string };
    if (!payload.text) return;
    if (payload.kind === "reasoning") {
      if (showReasoning) process.stdout.write(`\x1b[2m${payload.text}\x1b[0m`);
      return;
    }
    process.stdout.write(payload.text);
  });
  harness.on("tool.requested", (event) => {
    const payload = event.payload as { tool?: string; callId?: string };
    process.stdout.write(`\n[tool] ${payload.tool ?? "?"} (${payload.callId ?? "?"})\n`);
  });
  harness.on("model.failed", (event) => {
    const payload = event.payload as {
      error?: { code?: string; message?: string };
    };
    if (payload.error) {
      process.stderr.write(
        `\n[model error ${payload.error.code ?? "?"}] ${payload.error.message ?? ""}\n`,
      );
    }
  });
  harness.on("tool.failed", (event) => {
    const payload = event.payload as {
      tool?: string;
      error?: { code?: string; message?: string };
    };
    if (payload.error) {
      process.stderr.write(
        `\n[tool error ${payload.tool ?? "?"} ${payload.error.code ?? "?"}] ${payload.error.message ?? ""}\n`,
      );
    }
  });
  harness.on("turn.ended", (event) => {
    const payload = event.payload as { reason?: string };
    process.stdout.write(`\n[turn ${payload.reason ?? "?"}]\n`);
  });
  if (args.includes("--events")) {
    const print = (event: EventEnvelope): void => {
      const payload = JSON.stringify(event.payload);
      console.log(`[event] ${event.seq} ${event.type} ${payload}`);
    };
    harness.on("*", print);
  }

  try {
    await harness.start();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  if (headless) {
    console.log("web UI mode: open the URL printed above. Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await harness.stop();
    return;
  }

  const session = harness.createSession();
  console.log(`session ${session.id} model=${session.model}`);
  console.log("type a message; Ctrl+C cancels the current turn (twice to exit); Ctrl-D to exit");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let lastInterrupt = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastInterrupt < 2_000) {
      console.log("\nexiting");
      rl.close();
      return;
    }
    lastInterrupt = now;
    if (session.state === "active") {
      harness.cancel(session.id, "user", "ctrl+c");
      console.log("\n[cancelled] press Ctrl+C again to exit");
    } else {
      console.log("\n[press Ctrl+C again to exit]");
    }
  });
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      await harness.send(session.id, line);
    }
  } finally {
    rl.close();
    await harness.stop();
  }
}

if (import.meta.main) {
  await main();
}
