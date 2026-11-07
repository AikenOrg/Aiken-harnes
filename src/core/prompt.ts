import { createHash } from "node:crypto";
import type { EventBus } from "./bus.ts";
import type { Session } from "../protocol/session.ts";
import type {
  AssembledPrompt,
  PromptSegment,
  PromptSegmentInput,
  PromptStability,
} from "../protocol/prompt.ts";

const STABILITY_ORDER: Record<PromptStability, number> = {
  static: 0,
  session: 1,
  volatile: 2,
};

const DEFAULT_CORE_RULES = [
  "You are an agent harness. Use tools only through the provided schemas.",
  "Async tool results arrive as notifications at the end of history. Use read_result(id) for the body.",
  "Never attempt operations outside your granted capabilities.",
].join("\n");

export type PromptAssemblerOptions = {
  configPrompt?: string;
  coreRules?: string;
};

export type PromptTransform = (
  segments: PromptSegment[],
  session: Session,
) => PromptSegment[] | Promise<PromptSegment[]>;

export class PromptAssembler {
  #segments = new Map<string, PromptSegment>();
  #order = new Map<string, number>();
  #nextOrder = 0;
  #bus: EventBus;

  constructor(bus: EventBus, options: PromptAssemblerOptions = {}) {
    this.#bus = bus;
    const configPrompt = options.configPrompt?.trim();
    if (configPrompt) {
      this.#put({
        id: "config.system",
        source: "config",
        stability: "static",
        priority: 1000,
        content: configPrompt,
      });
    }
    this.#put({
      id: "core.rules",
      source: "core",
      stability: "static",
      priority: 900,
      content: (options.coreRules ?? DEFAULT_CORE_RULES).trim(),
    });
  }

  contribute(input: PromptSegmentInput, source: string): void {
    if (source === "config" || source === "core") {
      throw new Error("config/core prompt fragments cannot be contributed by modules");
    }
    if (input.content.trim().length === 0) throw new Error("prompt fragment must not be empty");
    if (this.#segments.has(input.id)) throw new Error(`prompt fragment already exists: ${input.id}`);
    this.#put({
      id: input.id,
      source,
      stability: input.stability,
      priority: input.priority,
      content: input.content,
    });
  }

  remove(id: string, source: string): void {
    const segment = this.#segments.get(id);
    if (!segment) return;
    if (segment.source === "config" || segment.source === "core") {
      throw new Error(`cannot remove ${segment.source} fragment: ${id}`);
    }
    if (segment.source !== source) throw new Error(`fragment ${id} belongs to ${segment.source}`);
    this.#segments.delete(id);
    this.#order.delete(id);
  }

  list(source?: string): PromptSegment[] {
    const all = [...this.#segments.values()];
    return source === undefined ? all : all.filter((segment) => segment.source === source);
  }

  async assemble(session: Session, transform?: PromptTransform): Promise<AssembledPrompt> {
    let segments = this.normalize([...this.#segments.values()]);
    if (transform) {
      segments = this.normalize(await transform(segments, session));
    }
    const cacheBoundary = segments.filter((segment) => segment.stability === "static").length;
    const staticContent = segments
      .slice(0, cacheBoundary)
      .map((segment) => segment.content)
      .join("\n\n");
    const hash = createHash("sha256").update(staticContent).digest("hex").slice(0, 16);

    this.#bus.emit(
      "prompt.assembled",
      {
        v: 1,
        segmentIds: segments.map((segment) => segment.id),
        cacheBoundary,
        hash,
      },
      { source: "core", sessionId: session.id },
    );
    return { segments, cacheBoundary, hash };
  }

  /** static -> session -> volatile、static 内は config 先頭、priority 降順。 */
  normalize(segments: PromptSegment[]): PromptSegment[] {
    return [...segments].sort((a, b) => {
      const stability = STABILITY_ORDER[a.stability] - STABILITY_ORDER[b.stability];
      if (stability !== 0) return stability;
      if (a.source === "config" && b.source !== "config") return -1;
      if (b.source === "config" && a.source !== "config") return 1;
      const priority = b.priority - a.priority;
      if (priority !== 0) return priority;
      return (this.#order.get(a.id) ?? 0) - (this.#order.get(b.id) ?? 0);
    });
  }

  #put(segment: PromptSegment): void {
    this.#segments.set(segment.id, segment);
    this.#order.set(segment.id, this.#nextOrder++);
  }
}
