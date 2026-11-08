import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../../src/protocol/events.ts";
import type { ModelEvent, ModelInfo, ModelRequest } from "../../src/protocol/provider.ts";
import { Harness } from "../../src/core/harness.ts";
import { createSequentialIds } from "../../src/core/ids.ts";
import { providerModule } from "./helpers.ts";

const PNG = Buffer.from("fake png").toString("base64");

class ImageProvider {
  requests: ModelRequest[] = [];
  models(): ModelInfo[] {
    return [
      {
        id: "mock/vision",
        provider: "mock",
        contextWindow: 100_000,
        maxOutput: 1_000,
        supportsTools: true,
        supportsImages: true,
        imageMediaTypes: ["image/png", "image/jpeg"],
      },
    ];
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) return;
    this.requests.push(structuredClone(request));
    yield { type: "text", delta: "seen" };
    yield { type: "stop", reason: "end" };
  }
}

function harnessFor(provider: ImageProvider, images = {}): Harness {
  return new Harness({
    config: {
      version: 1,
      modules: [],
      models: { default: "mock/vision" },
      images,
    },
    modules: [providerModule(provider as never, "provider-vision")],
    autoApprove: true,
    ids: createSequentialIds("img"),
  });
}

describe("images", () => {
  test("stores an image block and passes it to the provider", async () => {
    const provider = new ImageProvider();
    const harness = harnessFor(provider);
    const events: EventEnvelope[] = [];
    harness.on("*", (event) => events.push(event));
    await harness.start();
    const session = harness.createSession("mock/vision");
    await harness.send(session.id, "what is this?", {
      images: [{ mediaType: "image/png", data: PNG, name: "pixel.png" }],
    });
    const user = harness.history.read(session.id).find((message) => message.role === "user");
    expect(user?.blocks).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", data: PNG, name: "pixel.png" },
    ]);
    const requestUser = provider.requests[0]?.messages.find((message) => message.role === "user");
    expect(requestUser?.blocks.some((block) => block.type === "image")).toBe(true);
    expect(
      events.find((event) => event.type === "user.message")?.payload,
    ).toMatchObject({ text: "what is this?", imageCount: 1 });
    await harness.stop();
  });

  test("rejects unsupported models, media types, sizes, counts, and base64", async () => {
    const noImage: ModelInfo = {
      id: "mock/text",
      provider: "mock",
      contextWindow: 100_000,
      maxOutput: 1_000,
    };
    const textProvider = {
      models: () => [noImage],
      async *stream(): AsyncIterable<ModelEvent> {
        yield { type: "stop", reason: "end" };
      },
    };
    const textHarness = new Harness({
      config: { version: 1, modules: [], models: { default: "mock/text" } },
      modules: [providerModule(textProvider as never, "provider-text")],
      autoApprove: true,
      ids: createSequentialIds("imgtext"),
    });
    await textHarness.start();
    const textSession = textHarness.createSession("mock/text");
    expect(() =>
      textHarness.send(textSession.id, "x", {
        images: [{ mediaType: "image/png", data: PNG }],
      }),
    ).toThrow(/does not support image/);
    await textHarness.stop();

    const provider = new ImageProvider();
    const harness = harnessFor(provider, { maxBytes: 4, maxCount: 1, maxTotalBytes: 6 });
    await harness.start();
    const session = harness.createSession("mock/vision");
    expect(() =>
      harness.send(session.id, "x", {
        images: [{ mediaType: "image/svg+xml", data: PNG }],
      }),
    ).toThrow(/unsupported image type/);
    expect(() =>
      harness.send(session.id, "x", {
        images: [{ mediaType: "image/png", data: "YWJj!" }],
      }),
    ).toThrow(/canonical base64/);
    expect(() =>
      harness.send(session.id, "x", {
        images: [{ mediaType: "image/png", data: Buffer.from("too long").toString("base64") }],
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      harness.send(session.id, "x", {
        images: [
          { mediaType: "image/png", data: PNG },
          { mediaType: "image/png", data: PNG },
        ],
      }),
    ).toThrow(/too many images/);
    await harness.stop();
  });
});
