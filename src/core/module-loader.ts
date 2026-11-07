import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { moduleManifestSchema, type ModuleManifest } from "../protocol/manifest.ts";
import type { ModuleExports } from "../protocol/ctx.ts";
import type { ModuleDefinition } from "./module-host.ts";

/** D36: ディレクトリは manifest.json、ファイルは <basename>.manifest.json。 */
export async function loadModuleDefinition(use: string, baseDir: string): Promise<ModuleDefinition> {
  if (use.includes("://") || (!use.startsWith(".") && !use.startsWith("/") && use.includes("/") && !use.endsWith(".js") && !use.endsWith(".ts"))) {
    throw new Error(`external module fetch is not enabled: ${use}`);
  }
  const target = resolve(baseDir, use);
  const info = await stat(target);
  let manifestPath: string;
  let entryPath: string;

  if (info.isDirectory()) {
    manifestPath = join(target, "manifest.json");
    entryPath = target;
  } else {
    const extension = extname(target);
    manifestPath = join(dirname(target), `${basename(target, extension)}.manifest.json`);
    entryPath = target;
  }

  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const manifest = moduleManifestSchema.parse(raw) as ModuleManifest;
  if (info.isDirectory()) entryPath = resolve(entryPath, manifest.main ?? "index.js");

  const imported = (await import(pathToFileURL(entryPath).href)) as {
    default?: Partial<ModuleExports>;
    init?: ModuleExports["init"];
    dispose?: ModuleExports["dispose"];
    methods?: ModuleExports["methods"];
  };
  const source = imported.default ?? imported;
  if (typeof source.init !== "function") {
    throw new Error(`module ${manifest.name} does not export init()`);
  }

  const definition: ModuleDefinition = {
    manifest,
    init: source.init.bind(source),
  };
  if (typeof source.dispose === "function") definition.dispose = source.dispose.bind(source);
  if (source.methods !== undefined) definition.methods = source.methods;
  return definition;
}
