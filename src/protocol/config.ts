import { z } from "zod";
import { reasoningParamsSchema } from "./reasoning.ts";

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
  /** 最上位セッションの autoWake 既定値。サブエージェントは常に true が既定。 */
  autoWake: z.boolean().optional(),
  /** 連続して自動で起こす回数の上限。 */
  maxAutoWakeStreak: z.number().int().positive().optional(),
  /** summary の上限文字数 (コードポイント)。設定できる上限は 500。 */
  maxSummaryChars: z.number().int().positive().max(500).optional(),
  /** 1 回の通知メッセージ全体の上限文字数。 */
  maxNotificationChars: z.number().int().positive().optional(),
  /** 終端かつ通知済みの結果を掃除するまでの日数。 */
  resultTtlDays: z.number().int().positive().optional(),
});

export const contextConfigSchema = z.object({
  /** コンテキスト上限に対する使用率のしきい値。超えたら compaction か停止。 */
  overflowRatio: z.number().gt(0).max(1).optional(),
  /** 出力トークン上限 (length) で自動継続する回数。 */
  maxOutputContinuations: z.number().int().nonnegative().optional(),
});

export const agentsConfigSchema = z.object({
  maxDepth: z.number().int().positive().optional(),
  maxChildren: z.number().int().positive().optional(),
  maxAgents: z.number().int().positive().optional(),
  maxPromptBytes: z.number().int().positive().optional(),
  maxConcurrentModelCalls: z.number().int().positive().optional(),
});

export const logConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  file: z.string().optional(),
});

export const modelSettingsSchema = z.object({
  reasoning: reasoningParamsSchema.optional(),
});

export const configSchema = z.object({
  version: z.literal(1),
  modules: z.array(moduleEntrySchema),
  models: z
    .object({
      default: z.string().min(1),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "default") continue;
        const parsed = modelSettingsSchema.safeParse(entry);
        if (!parsed.success) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "model settings must be an object with an optional reasoning field",
          });
        }
      }
    }),
  /** 起動時の復元方針。none: 何もしない。last: 直前のセッションを自動で開く。 */
  restore: z.enum(["none", "last"]).optional(),
  /** 開発用 --approve-all を許可するか。本番では false。 */
  allowApproveAll: z.boolean().optional(),
  shell: shellConfigSchema.optional(),
  jobs: jobsConfigSchema.optional(),
  context: contextConfigSchema.optional(),
  agents: agentsConfigSchema.optional(),
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
export type ContextConfig = z.infer<typeof contextConfigSchema>;
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
