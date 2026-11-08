import { z } from "zod";
import type { AgentApi, ModuleExports } from "../../protocol/ctx.ts";

function tools(ctx: { agent: AgentApi }) {
  return [
    {
      name: "spawn_agent",
      description: "Spawn a subagent and return its session id and job id.",
      mode: "sync" as const,
      agentTool: true,
      input: z.object({
        task: z.string().min(1),
        prompt: z.string().optional(),
        volatile: z.string().optional(),
        model: z.string().optional(),
        tools: z.array(z.string()).optional(),
        autoWake: z.boolean().optional(),
        reasoning: z
          .object({
            effort: z.enum(["off", "low", "medium", "high", "max"]).optional(),
            budgetTokens: z.number().int().positive().optional(),
          })
          .optional(),
      }),
      handler: async (
        args: unknown,
        toolCtx: { sessionId: string },
      ) => {
        const value = args as {
          task: string;
          prompt?: string;
          volatile?: string;
          model?: string;
          tools?: string[];
          autoWake?: boolean;
          reasoning?: { effort?: "off" | "low" | "medium" | "high" | "max"; budgetTokens?: number };
        };
        const result = await ctx.agent.spawn({
          parentSessionId: toolCtx.sessionId,
          task: value.task,
          ...(value.prompt !== undefined ? { prompt: value.prompt } : {}),
          ...(value.volatile !== undefined ? { volatile: value.volatile } : {}),
          ...(value.model !== undefined ? { model: value.model } : {}),
          ...(value.tools !== undefined ? { tools: value.tools } : {}),
          ...(value.autoWake !== undefined ? { autoWake: value.autoWake } : {}),
          ...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
        });
        return { content: JSON.stringify(result), summary: `spawned ${result.sessionId}` };
      },
    },
    {
      name: "send_message",
      description: "Send a message to a descendant agent. Returns a job id.",
      mode: "sync" as const,
      agentTool: true,
      input: z.object({ sessionId: z.string().min(1), text: z.string().min(1) }),
      handler: async (args: unknown, toolCtx: { sessionId: string }) => {
        const value = args as { sessionId: string; text: string };
        const result = await ctx.agent.send(toolCtx.sessionId, value.sessionId, value.text);
        return { content: JSON.stringify(result), summary: "message queued" };
      },
    },
    {
      name: "list_agents",
      description: "List descendant agent sessions.",
      mode: "sync" as const,
      agentTool: true,
      input: z.object({}),
      handler: async (_args: unknown, toolCtx: { sessionId: string }) => {
        const sessions = await ctx.agent.list(toolCtx.sessionId);
        return {
          content: JSON.stringify(
            sessions.map((session) => ({
              id: session.id,
              parentId: session.parentId,
              state: session.state,
              model: session.model,
              autoWake: session.autoWake,
            })),
          ),
          summary: `${sessions.length} agent(s)`,
        };
      },
    },
    {
      name: "close_agent",
      description: "Close a descendant agent and its descendants.",
      mode: "sync" as const,
      agentTool: true,
      input: z.object({ sessionId: z.string().min(1) }),
      handler: async (args: unknown, toolCtx: { sessionId: string }) => {
        const value = args as { sessionId: string };
        await ctx.agent.close(toolCtx.sessionId, value.sessionId);
        return { content: JSON.stringify({ closed: value.sessionId }), summary: "agent closed" };
      },
    },
  ];
}

const module: ModuleExports = {
  init(ctx) {
    for (const tool of tools(ctx)) ctx.tools.register(tool);
  },
};

export default module;
export const init = module.init;
