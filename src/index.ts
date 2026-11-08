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
    console.log(`next-harness ${CORE_VERSION}`);
    console.log("usage: bun run src/index.ts --config <config.json> [--approve-all] [--events] [--env-file <path>] [--approvals <path>]");
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

  harness.on("model.delta", (event) => {
    const payload = event.payload as { text?: string };
    if (payload.text) process.stdout.write(payload.text);
  });
  harness.on("tool.requested", (event) => {
    const payload = event.payload as { tool?: string; callId?: string };
    process.stdout.write(`\n[tool] ${payload.tool ?? "?"} (${payload.callId ?? "?"})\n`);
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

  const session = harness.createSession();
  console.log(`session ${session.id} model=${session.model}`);
  console.log("type a message; Ctrl-D to exit");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
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
