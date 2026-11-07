/**
 * docs 内の相対 Markdown リンクが実在するか検査する。
 * 外部 URL、アンカーのみ、コードブロック内は対象外。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const targets = ["README.md", "CONTRIBUTING.md", "docs"];
const failures: string[] = [];
const checked: string[] = [];

function walk(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return path.endsWith(".md") ? [path] : [];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

function stripCodeFences(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inside = !inside;
      kept.push("");
      continue;
    }
    kept.push(inside ? "" : line);
  }
  return kept.join("\n");
}

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const target of targets) {
  const absolute = join(root, target);
  if (!existsSync(absolute)) {
    failures.push(`missing target: ${target}`);
    continue;
  }
  for (const file of walk(absolute)) {
    checked.push(relative(root, file));
    const text = stripCodeFences(readFileSync(file, "utf8"));
    for (const match of text.matchAll(linkPattern)) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      if (/^(https?:|mailto:|#)/.test(raw)) continue;
      const pathPart = raw.split("#")[0];
      if (!pathPart) continue;
      const resolved = resolve(dirname(file), pathPart);
      if (!existsSync(resolved)) {
        failures.push(`${relative(root, file)} -> ${raw}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Broken links:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`docs link check: ${checked.length} files ok`);
