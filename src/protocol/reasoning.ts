import { z } from "zod";

/** UI / config で扱う reasoning の強度。 */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
  "max",
];

export const reasoningParamsSchema = z.object({
  effort: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  budgetTokens: z.number().int().positive().optional(),
});

/** セッション / spawn / config で指定する reasoning。 */
export type ReasoningParams = {
  effort?: ReasoningEffort;
  budgetTokens?: number;
};

/** モデルが受け付ける reasoning の能力。 */
export type ReasoningCapability = {
  supported: boolean;
  /** 送信できる effort。UI はこの中から選ばせる。 */
  efforts?: ReasoningEffort[];
  /** on/off の切り替えだけを持つモデル。 */
  toggle?: boolean;
  /** thinking の budget_tokens を受け付ける。 */
  budget?: boolean;
};

export function isReasoningOff(params: ReasoningParams | undefined): boolean {
  return params?.effort === "off";
}
