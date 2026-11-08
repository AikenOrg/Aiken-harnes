import { z } from "zod";
import type { ToolDeclaration } from "./tools.ts";

/**
 * モジュールのロール。
 * 排他ロール: history-store / session-store / result-store / compactor / shell
 * 複数可: provider / ui
 * 1 つのモジュールが複数ロールを兼ねてよい。
 */
export type ModuleRole =
  | "provider"
  | "history-store"
  | "session-store"
  | "result-store"
  | "compactor"
  | "shell"
  | "ui";

/** 排他ロール。同時に 1 モジュールだけが持てる。 */
export const EXCLUSIVE_ROLES = [
  "history-store",
  "session-store",
  "result-store",
  "compactor",
  "shell",
] as const satisfies readonly ModuleRole[];

export type ExclusiveRole = (typeof EXCLUSIVE_ROLES)[number];

/** コア API 系の権限。ctx で実効的に強制される。 */
export type CoreCapability =
  | "history.read"
  | "history.append"
  | "history.restore"
  | "history.rewrite"
  | "prompt.contribute"
  | "session.manage"
  | "session.input"
  | "session.delete"
  | "job.read"
  | "job.cancel"
  | "agent.spawn"
  | "agent.message"
  | "tool.register"
  | "tool.intercept"
  | `module.talk:${string}`;

/** 外部資源系の権限。現状は宣言と承認のみ。 */
export type ExternalCapability =
  | "fs.read"
  | "fs.write"
  | "net"
  | "env"
  | "exec"
  | "secrets.read";

export type Capability = CoreCapability | ExternalCapability;

export type ExecMode = "full" | "whitelist";

/** manifest の permissions 要素。cap ごとに使う引数が異なる。 */
export type PermissionRequest = {
  cap: Capability;
  paths?: readonly string[];
  hosts?: readonly string[];
  names?: readonly string[];
  mode?: ExecMode;
  allow?: readonly string[];
};

/**
 * モジュール manifest。コードとは別の manifest.json に置く。
 * コアはコードを実行する前にこれを読み、権限承認を行う。
 */
export type ModuleManifest = {
  name: string;
  version: string;
  roles: readonly ModuleRole[];
  /** 落ちたら即停止するか。今は真偽値のみ。 */
  critical: boolean;
  /** 現状は "inprocess" のみ。 */
  runner: "inprocess";
  /** 同梱モジュール。承認確認を省略する。 */
  builtin?: boolean;
  /** モジュールディレクトリからのエントリポイント。既定は "index.js"。 */
  main?: string;
  requires?: readonly string[];
  talksTo?: readonly string[];
  subscribes?: readonly string[];
  permissions?: readonly PermissionRequest[];
  tools?: readonly ToolDeclaration[];
};

/** manifest.json の検証スキーマ。 */
export const moduleManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  roles: z.array(
    z.enum([
      "provider",
      "history-store",
      "session-store",
      "result-store",
      "compactor",
      "shell",
      "ui",
    ]),
  ),
  critical: z.boolean(),
  runner: z.literal("inprocess"),
  builtin: z.boolean().optional(),
  main: z.string().min(1).optional(),
  requires: z.array(z.string()).optional(),
  talksTo: z.array(z.string()).optional(),
  subscribes: z.array(z.string()).optional(),
  permissions: z
    .array(
      z.object({
        cap: z.string(),
        paths: z.array(z.string()).optional(),
        hosts: z.array(z.string()).optional(),
        names: z.array(z.string()).optional(),
        mode: z.enum(["full", "whitelist"]).optional(),
        allow: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        mode: z.enum(["sync", "async"]),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});
