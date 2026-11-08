import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { ModuleExports } from "../../protocol/ctx.ts";

const MAX_OUTPUT = 1_000_000;

const DEFAULT_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PWD",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "WINDIR",
];

const configSchema = z.object({
  mode: z.enum(["full", "whitelist"]).default("whitelist"),
  allow: z.array(z.string()).default([]),
  /** 既定の許可リストに追加する環境変数。秘密情報は追加しない。 */
  envAllow: z.array(z.string()).default([]),
});

type ShellConfig = z.infer<typeof configSchema>;

type RunResult = {
  aborted: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
};

function buildEnv(extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of new Set([...DEFAULT_ENV, ...extra])) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function executableOf(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  return (tokens[index] ?? "").replace(/^["']|["']$/g, "");
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 200);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

function runShell(
  command: string,
  cwd: string | undefined,
  signal: AbortSignal,
  config: ShellConfig,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const append = (current: string, chunk: Buffer | string): string => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = MAX_OUTPUT - current.length;
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      if (text.length > remaining) truncated = true;
      return current + text.slice(0, remaining);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd: cwd ?? process.cwd(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: buildEnv(config.envAllow),
      });
    } catch (error) {
      finish({
        aborted: false,
        stdout,
        stderr,
        truncated,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const onAbort = (): void => {
      killTree(child);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({ aborted: signal.aborted, stdout, stderr, truncated, error: error.message });
    });
    child.on("close", (exitCode, closeSignal) => {
      finish({
        aborted: signal.aborted,
        exitCode,
        signal: closeSignal,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

const module: ModuleExports = {
  init(ctx, rawConfig) {
    const config: ShellConfig = configSchema.parse(rawConfig);

    ctx.hooks.register("tool.before", (input) => {
      const value = input as { name?: string; args?: { command?: unknown } };
      if (value.name !== "shell") return;
      if (config.mode === "full") return;
      const command = typeof value.args?.command === "string" ? value.args.command : "";
      const executable = executableOf(command);
      if (!config.allow.includes(executable)) {
        return { decision: "deny", reason: `command not allowed: ${executable || "(empty)"}` };
      }
    });

    ctx.tools.register({
      name: "shell",
      description: "Run a shell command asynchronously and return a job id.",
      mode: "async",
      input: z.object({
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
      }),
      handler: (args, toolCtx) => {
        const { command, cwd } = args as { command: string; cwd?: string };
        const jobId = toolCtx.jobId;
        if (!jobId) throw new Error("shell tool requires a job id");
        void runShell(command, cwd, toolCtx.signal, config)
          .then((result) => {
            if (toolCtx.signal.aborted || result.aborted) return;
            if (result.error !== undefined) {
              ctx.jobs.fail(jobId, { code: "spawn_failed", message: result.error });
              return;
            }
            ctx.jobs.done(jobId, {
              summary: `exit ${result.exitCode ?? "null"}`,
              result: JSON.stringify({
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: result.stdout,
                stderr: result.stderr,
                truncated: result.truncated,
              }),
            });
          })
          .catch((error: unknown) => {
            if (toolCtx.signal.aborted) return;
            ctx.jobs.fail(jobId, {
              code: "shell_failed",
              message: error instanceof Error ? error.message : String(error),
            });
          });
      },
    });
  },
};

export default module;
export const init = module.init;
