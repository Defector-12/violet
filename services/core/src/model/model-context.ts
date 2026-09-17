import type { ModelContextProfile, ModelMessage } from "@violet/domain";

const perMessageOverheadTokens = 4;

export const deepSeekV41ContextProfile: ModelContextProfile = {
  contextWindowTokens: 1_000_000,
  estimateTokens: estimateConservativeTokens,
  maximumOutputTokens: 384_000,
};

export const deterministicContextProfile: ModelContextProfile = {
  contextWindowTokens: 131_072,
  estimateTokens: estimateConservativeTokens,
  maximumOutputTokens: 16_384,
};

export function estimateConservativeTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + perMessageOverheadTokens + Math.max(1, Buffer.byteLength(message.content, "utf8")),
    2,
  );
}
