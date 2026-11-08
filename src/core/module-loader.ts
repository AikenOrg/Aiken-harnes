import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { moduleManifestSchema, type ModuleManifest } from "../protocol/manifest.ts";
import type { ModuleExports } from "../protocol/ctx.ts";
import { hashModuleCode, type ModuleSource } from "./approvals.ts";
import type { ModuleDefinition } from "./module-host.ts";

/**
 * モジュールを記述子として読み込む。コードの import は承認後の activate() まで遅延する。
 * D36: ディレクトリは manifest.json、ファイルは <basename>.manifest.json。
 */
export async function loadModuleDefinition(use: string, baseDir: string): Promise<ModuleDefinition> {
  if (
    use.includes("://") ||
    (!use.startsWith(".") && !use.startsWith("/") && use.includes("/") && !use.endsWith(".js") && !use.endsWith(".ts"))
  ) {
    throw new Error(`external module fetch is not enabled: ${use}`);
  }
  const target = resolve(baseDir, use);
  const info = await stat(target);
  let manifestPath: string;
  let entryPath: string;
  let rootDir: string;
  const isDirectory = info.isDirectory();

  if (isDirectory) {
    manifestPath = join(target, "manifest.json");
    rootDir = target;
    entryPath = target;
  } else {
    const extension = extname(target);
    manifestPath = join(dirname(target), `${basename(target, extension)}.manifest.json`);
    rootDir = dirname(target);
    entryPath = target;
  }

  const manifest = moduleManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  ) as ModuleManifest;
  if (isDirectory) entryPath = resolve(entryPath, manifest.main ?? "index.js");

  const source: ModuleSource = { rootDir, entryPath, manifestPath, isDirectory };
  const codeHash = await hashModuleCode(source);

  return {
    manifest,
    source,
    codeHash,
    ...(manifest.builtin !== undefined ? { builtin: manifest.builtin } : {}),
    activate: async (): Promise<ModuleExports> => {
      const imported = (await import(pathToFileURL(entryPath).href)) as {
        default?: Partial<ModuleExports>;
        init?: ModuleExports["init"];
        dispose?: ModuleExports["dispose"];
        methods?: ModuleExports["methods"];
      };
      const exported = imported.default ?? imported;
      if (typeof exported.init !== "function") {
        throw new Error(`module ${manifest.name} does not export init()`);
      }
      const result: ModuleExports = { init: exported.init.bind(exported) };
      if (typeof exported.dispose === "function") result.dispose = exported.dispose.bind(exported);
      if (exported.methods !== undefined) result.methods = exported.methods;
      return result;
    },
  };
}
