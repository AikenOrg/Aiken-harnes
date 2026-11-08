import type { Session } from "../protocol/session.ts";
import type { PromptSegment } from "../protocol/prompt.ts";
import type { ToolMode } from "../protocol/tools.ts";
import type { HookType } from "../protocol/ctx.ts";

export type PromptAssembleHookInput = {
  session: Session;
  segments: PromptSegment[];
  cacheBoundary: number;
  isSubagent: boolean;
};

export type ToolBeforeHookInput = {
  session: Session;
  toolCallId: string;
  name: string;
  args: unknown;
  mode: ToolMode;
};

export type ToolBeforeResult = {
  decision?: "allow" | "deny";
  args?: unknown;
  reason?: string;
};

export type CompactionDecideInput = {
  session: Session;
  messageCount: number;
  tokenEstimate?: number;
  lastInputTokens?: number;
};

export type CompactionDecision = {
  action: "run" | "skip" | "defer";
  reason?: string;
};

export type AgentRouteHookInput = {
  from: string;
  to: string;
  kind: "spawn" | "message";
  text: string;
};

export type AgentRouteResult = {
  decision?: "allow" | "deny";
  text?: string;
  reason?: string;
};

type HookEntry = {
  type: HookType;
  module: string;
  handler: (input: never) => unknown;
};

export type ToolBeforeOutcome = {
  decision: "allow" | "deny";
  args: unknown;
  reason?: string;
  hook?: string;
};

/** フックを登録順に直列実行する。例外は隔離する。 */
export class HookRunner {
  #hooks: HookEntry[] = [];
  #log: (message: string, meta?: unknown) => void;

  constructor(log?: (message: string, meta?: unknown) => void) {
    this.#log = log ?? (() => {});
  }

  register(type: HookType, module: string, handler: (input: never) => unknown): () => void {
    const entry: HookEntry = { type, module, handler };
    this.#hooks.push(entry);
    return () => {
      const index = this.#hooks.indexOf(entry);
      if (index >= 0) this.#hooks.splice(index, 1);
    };
  }

  has(type: HookType): boolean {
    return this.#hooks.some((hook) => hook.type === type);
  }

  async runPromptAssemble(input: PromptAssembleHookInput): Promise<PromptSegment[]> {
    let segments = input.segments;
    for (const hook of this.#hooks.filter((item) => item.type === "prompt.assemble")) {
      try {
        const result = (hook.handler as (value: PromptAssembleHookInput) => unknown)({ ...input, segments });
        const resolved = await result;
        if (Array.isArray(resolved)) segments = resolved as PromptSegment[];
      } catch (error) {
        this.#log(`prompt.assemble hook failed in ${hook.module}`, error);
      }
    }
    return segments;
  }

  async runToolBefore(input: ToolBeforeHookInput): Promise<ToolBeforeOutcome> {
    let args = input.args;
    for (const hook of this.#hooks.filter((item) => item.type === "tool.before")) {
      let result: ToolBeforeResult | void;
      try {
        result = (await (hook.handler as (value: ToolBeforeHookInput) => unknown)({
          ...input,
          args,
        })) as ToolBeforeResult | void;
      } catch (error) {
        this.#log(`tool.before hook failed in ${hook.module}`, error);
        return { decision: "deny", args, reason: "tool.before hook failed", hook: hook.module };
      }
      if (!result) continue;
      if (result.decision === "deny") {
        const outcome: ToolBeforeOutcome = {
          decision: "deny",
          args,
          hook: hook.module,
        };
        if (result.reason !== undefined) outcome.reason = result.reason;
        return outcome;
      }
      if (result.args !== undefined) args = result.args;
    }
    return { decision: "allow", args };
  }

  async runAgentRoute(input: AgentRouteHookInput): Promise<{ text: string; denied?: string }> {
    let text = input.text;
    for (const hook of this.#hooks.filter((item) => item.type === "agent.route")) {
      let result: AgentRouteResult | void;
      try {
        result = (await (hook.handler as (value: AgentRouteHookInput) => unknown)({
          ...input,
          text,
        })) as AgentRouteResult | void;
      } catch (error) {
        this.#log(`agent.route hook failed in ${hook.module}`, error);
        return { text, denied: `agent.route hook failed: ${hook.module}` };
      }
      if (!result) continue;
      if (result.decision === "deny") {
        return { text, denied: result.reason ?? `denied by ${hook.module}` };
      }
      if (result.text !== undefined) text = result.text;
    }
    return { text };
  }

  runCompactionDecide(input: CompactionDecideInput): CompactionDecision {
    let sawSkip = false;
    for (const hook of this.#hooks.filter((item) => item.type === "compaction.decide")) {
      try {
        const result = (hook.handler as (value: CompactionDecideInput) => unknown)(input) as
          | CompactionDecision
          | void;
        if (result?.action === "run") return result;
        if (result?.action === "skip") sawSkip = true;
      } catch (error) {
        this.#log(`compaction.decide hook failed in ${hook.module}`, error);
      }
    }
    return sawSkip ? { action: "skip" } : { action: "defer" };
  }
}
