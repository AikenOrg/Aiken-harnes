import { homedir } from "node:os";
import { join } from "node:path";

/** OS のユーザー設定ディレクトリ。approvals.json / .env を置く。 */
export function userConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  return join(homedir(), ".config");
}

/** OS のユーザーデータディレクトリ。DB の既定置き場所。 */
export function userDataDir(): string {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return join(homedir(), ".local", "share");
}

export function userEnvFile(): string {
  return process.env.HARNESS_ENV_FILE ?? join(userConfigDir(), "next-harness", ".env");
}

export function defaultDbPath(): string {
  return join(userDataDir(), "next-harness", "harness.sqlite");
}
