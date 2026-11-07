import type { ToolDeclaration } from "./tools.ts";

/** モジュールのロール。排他・非排他の区別はコアが検査する。 */
export type ModuleRole =
  | "history-store"
  | "session-store"
  | "compactor"
  | "log-store"
  | "provider"
  | "shell"
  | "tools"
  | "ui"
  | "observer";

/** コア API 系の権限。ctx で実効的に強制される。 */
export type CoreCapability =
  | "history.read"
  | "history.append"
  | "history.rewrite"
  | "prompt.contribute"
  | "session.manage"
  | "agent.spawn"
  | "agent.message"
  | "tool.register"
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

/** モジュール manifest。 */
export type ModuleManifest = {
  name: string;
  version: string;
  roles: readonly ModuleRole[];
  /** 落ちたら即停止するか。今は真偽値のみ。 */
  critical: boolean;
  /** 現状は "inprocess" のみ。 */
  runner: "inprocess";
  requires?: readonly string[];
  talksTo?: readonly string[];
  subscribes?: readonly string[];
  permissions?: readonly PermissionRequest[];
  tools?: readonly ToolDeclaration[];
};
