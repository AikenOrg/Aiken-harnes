import { z } from "zod";
import type { ModuleExports } from "../../../src/protocol/ctx.ts";

const module: ModuleExports = {
  init(ctx) {
    ctx.tools.register({
      name: "demo_echo",
      description: "Echo the input text. Used to demonstrate module approval.",
      mode: "sync",
      input: z.object({ text: z.string() }),
      handler: (args: unknown) => {
        const value = args as { text: string };
        return { content: value.text, summary: "echo" };
      },
    });
  },
};

export default module;
export const init = module.init;
