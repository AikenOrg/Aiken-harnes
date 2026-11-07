import { z } from "zod";

/**
 * config.json のモジュール指定。
 * - 文字列: モジュールのパス (設定なし)
 * - オブジェクト: use + config
 * - ref: 外部取得用 (現時点では未解禁)
 */
export const moduleEntrySchema = z.union([
  z.string().min(1),
  z.object({
    use: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    ref: z.string().min(1).optional(),
  }),
]);

export const shellConfigSchema = z.object({
  mode: z.enum(["full", "whitelist"]),
  allow: z.array(z.string()).optional(),
});

export const jobsConfigSchema = z.object({
  /** async ツールの既定タイムアウト。 */
  defaultTimeoutMs: z.number().int().positive().optional(),
  /** ツールが宣言できるタイムアウトの上限。 */
  maxTimeoutMs: z.number().int().positive().optional(),
  /** セッションあたりの同時実行ジョブ数。 */
  maxConcurrentPerSession: z.number().int().positive().optional(),
  /** アイドル中にジョブが完了したとき、新しいターンを自動で始めるか。 */
  autoWake: z.boolean().optional(),
});

export const logConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  file: z.string().optional(),
});

export const configSchema = z.object({
  version: z.literal(1),
  modules: z.array(moduleEntrySchema),
  models: z.object({
    default: z.string().min(1),
  }),
  shell: shellConfigSchema.optional(),
  jobs: jobsConfigSchema.optional(),
  log: logConfigSchema.optional(),
  dataDir: z.string().optional(),
  prompt: z.object({
    system: z.string().optional(),
  }).optional(),
  secrets: z
    .record(
      z.string(),
      z.object({
        env: z.string().min(1),
      }),
    )
    .optional(),
});

export type ModuleEntry = z.infer<typeof moduleEntrySchema>;
export type HarnessConfig = z.infer<typeof configSchema>;
export type JobsConfig = z.infer<typeof jobsConfigSchema>;
export type ShellConfig = z.infer<typeof shellConfigSchema>;
