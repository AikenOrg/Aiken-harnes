import { ERROR_CODES, type CancelBy, type HarnessError } from "../protocol/common.ts";
import type { Block, NewMessage } from "../protocol/messages.ts";
import type { ModelEvent, ModelRequest, ModelInfo } from "../protocol/provider.ts";
import type { ReasoningParams } from "../protocol/reasoning.ts";
import type { ImageAttachment } from "../protocol/images.ts";
import type { Session } from "../protocol/session.ts";
import type { JobNotification } from "../protocol/jobs.ts";
import type { EventBus } from "./bus.ts";
import type { HistoryManager } from "./history.ts";
import type { HookRunner } from "./hooks.ts";
import type { JobManager } from "./jobs.ts";
import type { IdGenerator } from "./ids.ts";
import type { Semaphore } from "./semaphore.ts";
import type { Logger } from "./log.ts";
import type { PromptAssembler } from "./prompt.ts";
import type { ProviderRegistry } from "./providers.ts";
import type { SecretsBroker } from "./context.ts";
import type { SessionManager } from "./sessions.ts";
import type { ToolRegistry } from "./tools.ts";

const CONTINUE_AFTER_OUTPUT_LIMIT =
  "The previous response was cut off by the output token limit (stop reason: length). Continue the remaining work in smaller pieces. Do not repeat completed content or add an apology or recap.";

export type TurnLoopOptions = {
  bus: EventBus;
  sessions: SessionManager;
  history: HistoryManager;
  prompt: PromptAssembler;
  tools: ToolRegistry;
  jobs: JobManager;
  providers: ProviderRegistry;
  hooks: HookRunner;
  secrets: SecretsBroker;
  log: Logger;
  ids: IdGenerator;
  maxSteps?: number;
  overflowRatio?: number;
  maxNotificationChars?: number;
  maxOutputContinuations?: number;
  hasCompactor?: () => boolean;
  modelLimiter?: Semaphore;
  reasoningFor?: (session: Session) => ReasoningParams | undefined;
};

type ActiveTurn = {
  turnId: string;
  controller: AbortController;
};

function errorOf(error: unknown): HarnessError {
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const message = "message" in error && typeof error.message === "string" ? error.message : String(error);
    return { code: code ?? ERROR_CODES.internal, message };
  }
  return { code: ERROR_CODES.internal, message: String(error) };
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function textMessage(
  role: "system" | "user" | "assistant" | "tool" | "notification",
  text: string,
): NewMessage {
  return { role, blocks: [{ type: "text", text }] };
}

export type TurnResult = {
  reason: "completed" | "cancelled" | "error" | "context_overflow" | "length";
  finalText: string;
};

export class TurnLoop {
  #bus: EventBus;
  #sessions: SessionManager;
  #history: HistoryManager;
  #prompt: PromptAssembler;
  #tools: ToolRegistry;
  #jobs: JobManager;
  #providers: ProviderRegistry;
  #hooks: HookRunner;
  #secrets: SecretsBroker;
  #log: Logger;
  #ids: IdGenerator;
  #maxSteps: number;
  #overflowRatio: number;
  #maxNotificationChars: number;
  #maxOutputContinuations: number;
  #hasCompactor: () => boolean;
  #modelLimiter: Semaphore | undefined;
  #reasoningFor: ((session: Session) => ReasoningParams | undefined) | undefined;
  #active = new Map<string, ActiveTurn>();

  constructor(options: TurnLoopOptions) {
    this.#bus = options.bus;
    this.#sessions = options.sessions;
    this.#history = options.history;
    this.#prompt = options.prompt;
    this.#tools = options.tools;
    this.#jobs = options.jobs;
    this.#providers = options.providers;
    this.#hooks = options.hooks;
    this.#secrets = options.secrets;
    this.#log = options.log;
    this.#ids = options.ids;
    this.#maxSteps = options.maxSteps ?? 50;
    this.#overflowRatio = options.overflowRatio ?? 0.8;
    this.#maxNotificationChars = options.maxNotificationChars ?? 2000;
    this.#maxOutputContinuations = options.maxOutputContinuations ?? 2;
    this.#hasCompactor = options.hasCompactor ?? (() => false);
    this.#modelLimiter = options.modelLimiter;
    this.#reasoningFor = options.reasoningFor;
  }

  isActive(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  cancel(sessionId: string, by: CancelBy, reason?: string): boolean {
    const active = this.#active.get(sessionId);
    this.#jobs.cancelBySession(sessionId, by, reason);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  cancelAll(by: CancelBy, reason?: string): void {
    for (const sessionId of [...this.#active.keys()]) this.cancel(sessionId, by, reason);
  }

  async run(
    session: Session,
    text?: string,
    images?: ImageAttachment[],
  ): Promise<TurnResult> {
    const turnId = this.#ids.turn();
    const controller = new AbortController();
    this.#active.set(session.id, { turnId, controller });
    session.state = "active";

    if (text !== undefined || (images !== undefined && images.length > 0)) {
      const blocks: Block[] = [];
      if (text !== undefined && text.length > 0) blocks.push({ type: "text", text });
      for (const image of images ?? []) {
        const block: Block = {
          type: "image",
          mediaType: image.mediaType,
          data: image.data,
          ...(image.name !== undefined ? { name: image.name } : {}),
        };
        blocks.push(block);
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: text ?? "" });
      this.#bus.emit(
        "user.message",
        {
          v: 1,
          text: text ?? "",
          ...(images !== undefined && images.length > 0
            ? { imageCount: images.length }
            : {}),
        },
        { source: "core", sessionId: session.id },
      );
      this.#history.append(session.id, { role: "user", blocks });
    }
    this.#bus.emit("turn.started", { v: 1, turnId }, { source: "core", sessionId: session.id });

    let ended = false;
    let finalText = "";
    let continuationText = "";
    let outputContinuations = 0;
    let result: TurnResult = { reason: "error", finalText: "" };
    const end = (
      reason: "completed" | "cancelled" | "error" | "context_overflow" | "length",
      text?: string,
    ): void => {
      if (ended) return;
      ended = true;
      if (text !== undefined) finalText = text;
      result = { reason, finalText };
      if (session.state !== "closed") session.state = "idle";
      this.#bus.emit(
        "turn.ended",
        { v: 1, turnId, reason },
        { source: "core", sessionId: session.id },
      );
    };

    try {
      for (let step = 0; step < this.#maxSteps; step += 1) {
        if (controller.signal.aborted) {
          end("cancelled");
          return result;
        }
        this.#appendNotifications(session.id);

        const modelInfo = this.#providers.getModelInfo(session.model);
        if (this.#contextOverflow(session, modelInfo)) {
          if (!this.#hasCompactor()) {
            end("context_overflow");
            return result;
          }
        }

        const segments = await this.#prompt.assemble(session, async (current, currentSession) => {
          if (!this.#hooks.has("prompt.assemble")) return current;
          return this.#hooks.runPromptAssemble({
            session: currentSession,
            segments: current,
            cacheBoundary: current.filter((segment) => segment.stability === "static").length,
            isSubagent: currentSession.parentId !== undefined,
          });
        });

        const reasoning = this.#reasoningFor?.(session);
        const request: ModelRequest = {
          model: session.model,
          system: segments.segments,
          messages: this.#history.read(session.id),
          tools: this.#tools.specs(session.toolNames),
          sessionId: session.id,
          ...(reasoning !== undefined ? { params: { reasoning } } : {}),
        };

        this.#bus.emit(
          "model.requested",
          {
            v: 1,
            turnId,
            model: session.model,
            messageCount: request.messages.length,
            toolCount: request.tools.length,
            promptHash: segments.hash,
          },
          { source: "core", sessionId: session.id },
        );

        let responseText = "";
        let reasoningText = "";
        let reasoningOpaque: unknown;
        const reasoningBlocks: Array<{ text: string; opaque?: unknown }> = [];
        const flushReasoning = (): void => {
          if (reasoningText.length === 0 && reasoningOpaque === undefined) return;
          const block: { text: string; opaque?: unknown } = { text: reasoningText };
          if (reasoningOpaque !== undefined) block.opaque = reasoningOpaque;
          reasoningBlocks.push(block);
          reasoningText = "";
          reasoningOpaque = undefined;
        };
        const reasoningBlockList = (): Block[] => {
          flushReasoning();
          return reasoningBlocks.map((item) => {
            const block: Block = { type: "reasoning", text: item.text };
            if (item.opaque !== undefined) block.opaque = item.opaque;
            return block;
          });
        };
        const interruptedBlocks = (): Block[] => {
          const blocks = reasoningBlockList();
          if (responseText.length > 0) blocks.push({ type: "text", text: responseText });
          return blocks;
        };
        let stopReason: "end" | "tool_use" | "length" | "error" = "end";
        const toolCalls = new Map<string, { id: string; name: string; args: unknown }>();
        const usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };

        const provider = this.#providers.resolve(session.model);
        const providerModule = this.#providers.moduleOf(session.model);
        let releaseModel = (): void => {};
        if (this.#modelLimiter) {
          try {
            releaseModel = await this.#modelLimiter.acquire(controller.signal);
          } catch {
            if (controller.signal.aborted) {
              end("cancelled", responseText);
              return result;
            }
            throw new Error("model call limiter failed");
          }
        }
        this.#secrets.begin(providerModule);
        try {
          for await (const event of provider.stream(request, controller.signal)) {
            if (controller.signal.aborted) break;
            this.#consumeModelEvent(event, {
              onText: (delta) => {
                responseText += delta;
                this.#bus.emit(
                  "model.delta",
                  { v: 2, turnId, text: delta, kind: "text" },
                  { source: "core", sessionId: session.id },
                );
              },
              onReasoning: (delta) => {
                reasoningText += delta;
                if (session.reasoningIgnored !== undefined) {
                  this.#sessions.setReasoningIgnored(session.id, "");
                }
                this.#bus.emit(
                  "model.delta",
                  { v: 2, turnId, text: delta, kind: "reasoning" },
                  { source: "core", sessionId: session.id },
                );
              },
              onReasoningEnd: (opaque) => {
                if (opaque !== undefined) reasoningOpaque = opaque;
                flushReasoning();
              },
              onReasoningIgnored: (reason) => {
                this.#sessions.setReasoningIgnored(session.id, reason);
                this.#log.warn(`reasoning ignored for ${session.model}: ${reason}`);
              },
              onToolCall: (call) => toolCalls.set(call.id, call),
              onUsage: (next) => {
                usage.input += next.input;
                usage.output += next.output;
                usage.cacheRead += next.cacheRead ?? 0;
                usage.reasoning += next.reasoning ?? 0;
              },
              onStop: (reason) => {
                stopReason = reason;
              },
            });
          }
        } catch (error) {
          if (controller.signal.aborted) {
            const blocks = interruptedBlocks();
            if (blocks.length > 0) {
              this.#history.append(session.id, {
                role: "assistant",
                blocks,
                interrupted: true,
              });
            }
            end("cancelled", responseText);
            return result;
          }
          const harnessError = errorOf(error);
          this.#bus.emit(
            "model.failed",
            { v: 1, turnId, error: harnessError },
            { source: "core", sessionId: session.id },
          );
          if (errorCodeOf(error) === "context_overflow" || errorCodeOf(error) === "context_length_exceeded") {
            end("context_overflow");
          } else {
            end("error");
          }
          return result;
        } finally {
          this.#secrets.end(providerModule);
          releaseModel();
        }

        if (controller.signal.aborted) {
          const blocks = interruptedBlocks();
          if (blocks.length > 0) {
            this.#history.append(session.id, {
              role: "assistant",
              blocks,
              interrupted: true,
            });
          }
          end("cancelled", responseText);
          return result;
        }

        this.#bus.emit(
          "model.completed",
          {
            v: 1,
            turnId,
            usage: {
              input: usage.input,
              output: usage.output,
              ...(usage.cacheRead > 0 ? { cacheRead: usage.cacheRead } : {}),
              ...(usage.reasoning > 0 ? { reasoning: usage.reasoning } : {}),
            },
            stop: stopReason,
          },
          { source: "core", sessionId: session.id },
        );
        if (usage.input > 0) this.#sessions.setLastInputTokens(session.id, usage.input);

        const finalStop = stopReason as "end" | "tool_use" | "length" | "error";
        if (finalStop === "error") {
          this.#bus.emit(
            "model.failed",
            {
              v: 1,
              turnId,
              error: { code: "model_error", message: "provider stopped with error" },
            },
            { source: "core", sessionId: session.id },
          );
          end("error");
          return result;
        }

        const truncated = finalStop === "length";
        const blocks: Block[] = reasoningBlockList();
        if (responseText.length > 0) blocks.push({ type: "text", text: responseText });
        if (!truncated) {
          for (const call of toolCalls.values()) {
            blocks.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
          }
        }
        if (blocks.length > 0) {
          this.#history.append(session.id, {
            role: "assistant",
            blocks,
            ...(truncated ? { truncated: true } : {}),
          });
        }
        if (truncated) {
          if (outputContinuations >= this.#maxOutputContinuations) {
            end("length", continuationText + responseText);
            return result;
          }
          outputContinuations += 1;
          continuationText += responseText;
          this.#history.append(session.id, textMessage("system", CONTINUE_AFTER_OUTPUT_LIMIT));
          continue;
        }
        outputContinuations = 0;
        continuationText = "";

        if (toolCalls.size === 0) {
          end("completed", continuationText + responseText);
          return result;
        }

        for (const call of toolCalls.values()) {
          if (controller.signal.aborted) {
            end("cancelled", responseText);
            return result;
          }
          await this.#executeTool(session, call, controller.signal);
        }
      }
      end("error");
      return result;
    } catch (error) {
      this.#log.error("turn loop failed", error);
      end("error");
      return result;
    } finally {
      this.#active.delete(session.id);
    }
  }

  #consumeModelEvent(
    event: ModelEvent,
    handlers: {
      onText: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onReasoningEnd: (opaque?: unknown) => void;
      onReasoningIgnored: (reason: string) => void;
      onToolCall: (call: { id: string; name: string; args: unknown }) => void;
      onUsage: (usage: {
        input: number;
        output: number;
        cacheRead?: number;
        reasoning?: number;
      }) => void;
      onStop: (reason: "end" | "tool_use" | "length" | "error") => void;
    },
  ): void {
    if (event.type === "text") handlers.onText(event.delta);
    else if (event.type === "reasoning") handlers.onReasoning(event.delta);
    else if (event.type === "reasoning_end") handlers.onReasoningEnd(event.opaque);
    else if (event.type === "reasoning_ignored") handlers.onReasoningIgnored(event.reason);
    else if (event.type === "tool_call") handlers.onToolCall({ id: event.id, name: event.name, args: event.args });
    else if (event.type === "usage") {
      handlers.onUsage({
        input: event.input,
        output: event.output,
        ...(event.cacheRead !== undefined ? { cacheRead: event.cacheRead } : {}),
        ...(event.reasoning !== undefined ? { reasoning: event.reasoning } : {}),
      });
    } else if (event.type === "stop") handlers.onStop(event.reason);
  }

  #contextOverflow(session: Session, model: ModelInfo): boolean {
    if (session.lastInputTokens === undefined) return false;
    const maxTokens = model.maxOutput ?? 0;
    return session.lastInputTokens + maxTokens > this.#overflowRatio * model.contextWindow;
  }

  #appendNotifications(sessionId: string): void {
    const pending = this.#jobs.pendingNotifications(sessionId);
    if (pending.length === 0) return;
    const entries: JobNotification[] = [];
    let characters = 2;
    for (const job of pending) {
      if (job.status === "running") continue;
      const entry: JobNotification = {
        id: job.id,
        status: job.status,
        summary: job.summary ?? "",
        size: job.size ?? 0,
      };
      const nextLength = characters + JSON.stringify(entry).length + 1;
      if (entries.length > 0 && nextLength > this.#maxNotificationChars) break;
      entries.push(entry);
      characters = nextLength;
    }

    const included = new Set(entries.map((entry) => entry.id));
    const omitted = pending.filter((job) => !included.has(job.id));
    const blocks: Block[] = [{ type: "notification", entries }];
    if (omitted.length > 0) {
      const ids = omitted.slice(0, 20).map((job) => job.id).join(", ");
      blocks.push({ type: "text", text: `ほか ${omitted.length} 件: ${ids}` });
    }
    this.#history.append(sessionId, { role: "notification", blocks });
    this.#jobs.markNotified(pending.map((job) => job.id));
  }

  async #executeTool(
    session: Session,
    call: { id: string; name: string; args: unknown },
    signal: AbortSignal,
  ): Promise<void> {
    const tool = this.#tools.get(call.name);
    const mode = tool?.mode ?? "sync";
    this.#bus.emit(
      "tool.requested",
      { v: 1, callId: call.id, tool: call.name, mode },
      { source: "core", sessionId: session.id },
    );

    if (session.toolNames !== undefined && !session.toolNames.includes(call.name)) {
      this.#appendToolResult(session.id, call.id, call.name, `tool not allowed for this session: ${call.name}`, true);
      this.#bus.emit(
        "tool.failed",
        {
          v: 1,
          callId: call.id,
          tool: call.name,
          error: { code: "invalid_state", message: "tool not allowed for this session" },
        },
        { source: "core", sessionId: session.id },
      );
      return;
    }

    if (!tool) {
      this.#appendToolResult(session.id, call.id, call.name, `tool not found: ${call.name}`, true);
      this.#bus.emit(
        "tool.failed",
        { v: 1, callId: call.id, tool: call.name, error: { code: "not_found", message: "tool not found" } },
        { source: "core", sessionId: session.id },
      );
      return;
    }

    const parsed = tool.input.safeParse(call.args);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join("; ");
      this.#appendToolResult(session.id, call.id, call.name, `invalid arguments: ${message}`, true);
      this.#bus.emit(
        "tool.failed",
        { v: 1, callId: call.id, tool: call.name, error: { code: "invalid_args", message } },
        { source: "core", sessionId: session.id },
      );
      return;
    }

    let args: unknown = parsed.data;
    if (this.#hooks.has("tool.before")) {
      const outcome = await this.#hooks.runToolBefore({
        session,
        toolCallId: call.id,
        name: call.name,
        args,
        mode,
      });
      if (outcome.decision === "deny") {
        const message = outcome.reason ?? "denied by tool.before hook";
        this.#bus.emit(
          "permission.denied",
          {
            v: 1,
            module: outcome.hook ?? "hook",
            cap: "tool.execute",
            hook: "tool.before",
            error: { code: ERROR_CODES.denied, message },
          },
          { source: "core", sessionId: session.id },
        );
        this.#bus.emit(
          "tool.failed",
          { v: 1, callId: call.id, tool: call.name, error: { code: ERROR_CODES.denied, message } },
          { source: "core", sessionId: session.id },
        );
        this.#appendToolResult(session.id, call.id, call.name, message, true);
        return;
      }
      args = outcome.args;
      const revalidated = tool.input.safeParse(args);
      if (!revalidated.success) {
        this.#appendToolResult(session.id, call.id, call.name, "invalid arguments after hook", true);
        return;
      }
      args = revalidated.data;
    }

    if (mode === "async") {
      let created;
      try {
        created = this.#jobs.create({
          sessionId: session.id,
          ownerSessionId: session.id,
          callId: call.id,
          tool: call.name,
          module: tool.module,
          ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        });
      } catch (error) {
        const harnessError = errorOf(error);
        const runningJobIds =
          typeof error === "object" && error !== null && "runningJobIds" in error
            ? (error as { runningJobIds?: unknown }).runningJobIds
            : undefined;
        const content = JSON.stringify({
          code: harnessError.code,
          message: harnessError.message,
          ...(Array.isArray(runningJobIds) ? { runningJobIds } : {}),
        });
        this.#bus.emit(
          "tool.failed",
          { v: 1, callId: call.id, tool: call.name, error: harnessError },
          { source: "core", sessionId: session.id },
        );
        this.#appendToolResult(session.id, call.id, call.name, content, true);
        return;
      }

      this.#bus.emit(
        "tool.started",
        { v: 1, callId: call.id, tool: call.name, jobId: created.job.id },
        { source: "core", sessionId: session.id },
      );
      const started = Date.now();
      Promise.resolve()
        .then(() =>
          tool.handler(args, {
            sessionId: session.id,
            toolCallId: call.id,
            jobId: created.job.id,
            signal: created.signal,
          }),
        )
        .catch((error: unknown) => {
          this.#jobs.fail(created.job.id, tool.module, errorOf(error));
        });
      this.#bus.emit(
        "tool.completed",
        {
          v: 1,
          callId: call.id,
          tool: call.name,
          jobId: created.job.id,
          durationMs: Date.now() - started,
        },
        { source: "core", sessionId: session.id },
      );
      this.#appendToolResult(session.id, call.id, call.name, JSON.stringify({ jobId: created.job.id }), false);
      return;
    }

    const started = Date.now();
    this.#bus.emit(
      "tool.started",
      { v: 1, callId: call.id, tool: call.name },
      { source: "core", sessionId: session.id },
    );
    try {
      const result = await tool.handler(args, {
        sessionId: session.id,
        toolCallId: call.id,
        signal,
      });
      if (result === undefined) throw new Error("sync tool returned no result");
      this.#appendToolResult(session.id, call.id, call.name, result.content, result.isError ?? false);
      this.#bus.emit(
        "tool.completed",
        {
          v: 1,
          callId: call.id,
          tool: call.name,
          size: new TextEncoder().encode(result.content).byteLength,
          durationMs: Date.now() - started,
        },
        { source: "core", sessionId: session.id },
      );
    } catch (error) {
      const harnessError = errorOf(error);
      this.#appendToolResult(session.id, call.id, call.name, harnessError.message, true);
      this.#bus.emit(
        "tool.failed",
        { v: 1, callId: call.id, tool: call.name, error: harnessError, durationMs: Date.now() - started },
        { source: "core", sessionId: session.id },
      );
    }
  }

  #appendToolResult(sessionId: string, toolCallId: string, name: string, content: string, isError: boolean): void {
    const message: NewMessage = {
      role: "tool",
      blocks: [
        {
          type: "tool_result",
          toolCallId,
          name,
          content,
          ...(isError ? { isError } : {}),
        },
      ],
    };
    this.#history.append(sessionId, message);
  }
}

/** Provider の usage を合算するための補助。 */
export function sumUsage(
  a: { input: number; output: number; cacheRead?: number },
  b: { input: number; output: number; cacheRead?: number },
): { input: number; output: number; cacheRead?: number } {
  const cacheRead = (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(cacheRead > 0 ? { cacheRead } : {}),
  };
}

