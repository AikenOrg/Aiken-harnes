import { createInterface } from "node:readline/promises";
import type { ApprovalDecision, ApprovalRequest } from "../../protocol/approval.ts";
import type { ModuleExports } from "../../protocol/ctx.ts";

const methods: Record<string, (...args: unknown[]) => unknown> = {};

const module: ModuleExports = {
  init() {
    methods.requestApproval = async (value: unknown): Promise<ApprovalDecision> => {
      const request = value as ApprovalRequest;
      if (!process.stdin.isTTY) {
        return { approved: false, reason: "approval requires an interactive terminal" };
      }
      process.stdout.write("\n");
      process.stdout.write(`Module approval required: ${request.module}@${request.version}\n`);
      process.stdout.write(`roles: ${request.roles.join(", ") || "(none)"}\n`);
      process.stdout.write(`permissions:\n`);
      for (const permission of request.permissions) process.stdout.write(`  - ${permission}\n`);
      if (request.changes.length > 0) {
        process.stdout.write(`changes:\n`);
        for (const change of request.changes) process.stdout.write(`  - ${change}\n`);
      }
      if (request.warnings.length > 0) {
        process.stdout.write(`WARNINGS:\n`);
        for (const warning of request.warnings) process.stdout.write(`  ! ${warning}\n`);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question("Approve this module? [y/N] ");
        return { approved: /^y(es)?$/i.test(answer.trim()) };
      } finally {
        rl.close();
      }
    };
  },
  methods,
};

export default module;
export const init = module.init;
export const methodTable = methods;
