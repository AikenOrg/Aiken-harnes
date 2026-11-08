import { basename, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { ModuleExports } from "../../protocol/ctx.ts";

const DENIED_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "approvals.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const DENIED_DIRECTORIES = new Set([".git", ".ssh"]);

function isDenied(baseDir: string, path: string): boolean {
  const absolute = resolve(baseDir, path);
  const rel = relative(baseDir, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return true;
  const normalized = rel.split(/[\\/]+/).join("/");
  const parts = normalized.split("/").filter(Boolean);
  const name = basename(normalized);

  if (/^\.env(?:\.|$)/i.test(name)) return true;
  if (DENIED_BASENAMES.has(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(name)) return true;
  if (/^(credentials|secrets)\.(json|ya?ml|toml)$/i.test(name)) return true;
  if (/\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(name)) return true;
  if (parts.some((part) => DENIED_DIRECTORIES.has(part))) return true;
  return false;
}

const module: ModuleExports = {
  init(ctx) {
    ctx.tools.register({
      name: "read",
      description: "Read a UTF-8 text file inside the workspace. Secrets and .git/.ssh are denied.",
      mode: "sync",
      input: z.object({ path: z.string().min(1) }),
      handler: async (args) => {
        const { path } = args as { path: string };
        try {
          const real = await ctx.fs.realpath(path);
          if (isDenied(ctx.fs.baseDir, real)) {
            return { content: `read denied by policy: ${path}`, isError: true };
          }
          const data = await ctx.fs.read(path);
          return { content: new TextDecoder().decode(data) };
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
    });
  },
};

export default module;
export const init = module.init;
