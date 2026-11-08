import { readFile } from "node:fs/promises";
import { userEnvFile } from "../shared/paths.ts";

export { defaultDbPath, userConfigDir, userDataDir, userEnvFile } from "../shared/paths.ts";

/** 最小限の .env パーサ。既存の環境変数は上書きしない。 */
export function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export type LoadUserEnvResult = {
  loaded: boolean;
  path: string;
  keys: string[];
};

/** ユーザー設定ディレクトリの .env を process.env に読み込む。値はログに出さない。 */
export async function loadUserEnv(path = userEnvFile()): Promise<LoadUserEnvResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { loaded: false, path, keys: [] };
    }
    throw error;
  }
  const values = parseEnv(content);
  const keys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, path, keys };
}
