import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessConfig } from "../../src/protocol/config.ts";
import type { ModuleDefinition } from "../../src/core/module-host.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { loadUserEnv, parseEnv } from "../../src/core/user-env.ts";
import { loadModuleDefinition } from "../../src/core/module-loader.ts";
import { lastJobId, providerModule, ScriptedProvider } from "../core/helpers.ts";

const tempDirs: string[] = [];

function config(): HarnessConfig {
  return { version: 1, modules: [], models: { default: "mock/script" } };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-harness-sec-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function shellModule(mode: "full" | "whitelist", allow: string[]): Promise<ModuleDefinition> {
  const definition = await loadModuleDefinition("./src/modules/shell", process.cwd());
  definition.config = { mode, allow };
  return definition;
}

describe("security boundaries", () => {
  test("shell does not pass secret environment variables to child processes", async () => {
    const previous = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "secret-test-value";
    try {
      const shell = await shellModule("full", []);
      const provider = new ScriptedProvider([
        {
          toolCalls: [{ id: "call_env", name: "shell", args: { command: "env | grep OPENCODE" } }],
          stop: "tool_use",
        },
        (request) => ({
          toolCalls: [{ id: "call_wait", name: "wait", args: { ids: [lastJobId(request)], timeoutMs: 2000 } }],
          stop: "tool_use",
        }),
        (request) => ({
          toolCalls: [{ id: "call_read", name: "read_result", args: { id: lastJobId(request) } }],
          stop: "tool_use",
        }),
        { text: "checked", stop: "end" },
      ]);
      const harness = new Harness({
        config: config(),
        modules: [providerModule(provider), shell],
        autoApprove: true,
        ids: createSequentialIds("envsec"),
      });
      await harness.start();
      const session = harness.createSession();
      await harness.send(session.id, "check env");
      const readResult = harness.history
        .read(session.id)
        .flatMap((message) => message.blocks)
        .find((block) => block.type === "tool_result" && block.name === "read_result");
      const content = (readResult as { content: string }).content;
      expect(content).not.toContain("secret-test-value");
      expect(content).not.toContain("OPENCODE_API_KEY");
      await harness.stop();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
    }
  });

  test("read tool denies .env, secret files, and paths outside the workspace", async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(dir, ".env"), "OPENCODE_API_KEY=secret", "utf8");
    await writeFile(join(dir, "README.md"), "hello", "utf8");
    await writeFile(join(dir, "id_rsa"), "private", "utf8");
    await writeFile(join(dir, "harness.sqlite"), "db", "utf8");
    await symlink(join(dir, ".env"), join(dir, "safe.txt"));
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");

    const readModule = await loadModuleDefinition("./src/modules/tools-read", process.cwd());
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "r1", name: "read", args: { path: ".env" } }], stop: "tool_use" },
      { toolCalls: [{ id: "r2", name: "read", args: { path: "id_rsa" } }], stop: "tool_use" },
      { toolCalls: [{ id: "r3", name: "read", args: { path: "../outside.txt" } }], stop: "tool_use" },
      { toolCalls: [{ id: "r4", name: "read", args: { path: "safe.txt" } }], stop: "tool_use" },
      { toolCalls: [{ id: "r5", name: "read", args: { path: "README.md" } }], stop: "tool_use" },
      { toolCalls: [{ id: "r6", name: "read", args: { path: "harness.sqlite" } }], stop: "tool_use" },
      { text: "done", stop: "end" },
    ]);
    const harness = new Harness({
      config: config(),
      modules: [providerModule(provider), readModule],
      autoApprove: true,
      baseDir: dir,
      ids: createSequentialIds("readsec"),
    });
    await harness.start();
    const session = harness.createSession();
    await harness.send(session.id, "read files");
    const results = harness.history
      .read(session.id)
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === "tool_result") as Array<{
      type: "tool_result";
      content: string;
      isError?: boolean;
    }>;

    expect(results[0]?.isError).toBe(true);
    expect(results[1]?.isError).toBe(true);
    expect(results[2]?.isError).toBe(true);
    expect(results[3]?.isError).toBe(true);
    expect(results[4]).toMatchObject({ content: "hello" });
    expect(results[5]?.isError).toBe(true);
    await harness.stop();
  });

  test("user env loader reads a file without overriding existing env", async () => {
    const dir = await tempDir();
    const file = join(dir, ".env");
    await writeFile(file, "NEXT_HARNESS_TEST_KEY=from-file\n", "utf8");
    delete process.env.NEXT_HARNESS_TEST_KEY;
    const loaded = await loadUserEnv(file);
    expect(loaded.loaded).toBe(true);
    expect(loaded.keys).toContain("NEXT_HARNESS_TEST_KEY");
    expect((process.env as Record<string, string | undefined>).NEXT_HARNESS_TEST_KEY).toBe("from-file");

    process.env.NEXT_HARNESS_TEST_KEY = "from-process";
    await loadUserEnv(file);
    expect((process.env as Record<string, string | undefined>).NEXT_HARNESS_TEST_KEY).toBe("from-process");
    delete process.env.NEXT_HARNESS_TEST_KEY;
    expect(parseEnv("export A=1\nB='two'\n# C=3\n")).toEqual({ A: "1", B: "two" });
  });
});
