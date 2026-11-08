import { z } from "zod";
import type { ToolDeclaration, ToolDefinition, ToolSpec } from "../protocol/tools.ts";

export type RegisteredTool = ToolDefinition & { module: string };

export class ToolRegistry {
  #tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, module: string): void {
    if (this.#tools.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(definition.name)) {
      throw new Error(`invalid tool name: ${definition.name}`);
    }
    this.#tools.set(definition.name, { ...definition, module });
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.#tools.values()];
  }

  names(): string[] {
    return this.list().map((tool) => tool.name);
  }

  isAgentTool(name: string): boolean {
    return this.#tools.get(name)?.agentTool === true;
  }

  declarations(): ToolDeclaration[] {
    return this.list().map((tool) => {
      const declaration: ToolDeclaration = { name: tool.name, mode: tool.mode };
      if (tool.timeoutMs !== undefined) declaration.timeoutMs = tool.timeoutMs;
      return declaration;
    });
  }

  specs(toolNames?: readonly string[]): ToolSpec[] {
    const allowed = toolNames === undefined ? undefined : new Set(toolNames);
    return this.list()
      .filter((tool) => allowed === undefined || allowed.has(tool.name))
      .map((tool) => {
        const jsonSchema = z.toJSONSchema(tool.input, { io: "input" });
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: jsonSchema as Record<string, unknown>,
        };
      });
  }
}
