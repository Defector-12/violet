import { describe, expect, it } from "vitest";

import {
  deepSeekV41ContextProfile,
  deterministicContextProfile,
  estimateConservativeTokens,
} from "./model-context.js";

describe("model context profiles", () => {
  it("declares the official DeepSeek V4.1 Flash limits", () => {
    expect(deepSeekV41ContextProfile).toMatchObject({
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 384_000,
    });
  });

  it("uses a conservative UTF-8 byte upper bound", () => {
    const messages = [
      { content: "abc", role: "user" as const },
      { content: "中文", role: "assistant" as const },
    ];

    expect(estimateConservativeTokens(messages)).toBeGreaterThanOrEqual(3 + 6);
    expect(deterministicContextProfile.estimateTokens(messages)).toBe(
      estimateConservativeTokens(messages),
    );
  });
});
