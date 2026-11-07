import { z } from "zod";
import type { ModuleExports } from "../../protocol/ctx.ts";

const module: ModuleExports = {
  init(ctx) {
    ctx.tools.register(
      {
        name: "read",
        description: "Read a UTF-8 text file inside the workspace.",
        mode: "sync",
        input: z.object({ path: z.string().min(1) }),
        handler: async (args) => {
          const { path } = args as { path: string };
          try {
            const data = await ctx.fs.read(path);
            return { content: new TextDecoder().decode(data) };
          } catch (error) {
            return {
              content: error instanceof Error ? error.message : String(error),
              isError: true,
            };
          }
        },
      },
    );
  },
};

export default module;
export const init = module.init;
