export * from "./protocol/index.ts";
import { CORE_VERSION } from "./protocol/version.ts";

if (import.meta.main) {
  console.log(`next-harness ${CORE_VERSION}`);
  console.log("core は未実装です。docs/spec/13-roadmap.md の M1 から着手してください。");
}
