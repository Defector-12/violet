import type { ModelGateway, ModelRequest } from "@violet/domain";
import { describe, expect, it } from "vitest";

import { ModelConversationEndIntent } from "./conversation-end-intent.js";

describe("ModelConversationEndIntent", () => {
  it("classifies a clear farewell with a strict model response", async () => {
    let observedRequest: ModelRequest | undefined;
    const classifier = new ModelConversationEndIntent(
      modelReturning("END", (request) => {
        observedRequest = request;
      }),
    );

    await expect(
      classifier.shouldEnd({
        text: "今天就到这里吧",
        turnId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBe(true);
    expect(observedRequest?.messages).toMatchObject([
      { role: "system" },
      { content: "今天就到这里吧", role: "user" },
    ]);
  });

  it("does not accept explanatory or malformed classifier output", async () => {
    const continueClassifier = new ModelConversationEndIntent(modelReturning("CONTINUE"));
    const malformedClassifier = new ModelConversationEndIntent(modelReturning("END because..."));

    await expect(
      continueClassifier.shouldEnd({
        text: "如何实现结束对话功能",
        turnId: "00000000-0000-4000-8000-000000000002",
      }),
    ).resolves.toBe(false);
    await expect(
      malformedClassifier.shouldEnd({
        text: "ambiguous",
        turnId: "00000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toBe(false);
  });
});

function modelReturning(content: string, observe?: (request: ModelRequest) => void): ModelGateway {
  return {
    async *stream(request) {
      observe?.(request);
      yield { content, type: "delta" };
      yield { inputTokens: 1, outputTokens: 1, type: "complete" };
    },
  };
}
