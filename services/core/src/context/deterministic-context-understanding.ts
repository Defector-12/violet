import type {
  ContextUnderstandingPort,
  ContextUnderstandingRequest,
  ContextUnderstandingResult,
} from "@violet/domain";

export class DeterministicContextUnderstandingPort implements ContextUnderstandingPort {
  async understand(request: ContextUnderstandingRequest): Promise<ContextUnderstandingResult> {
    const image =
      request.payload.type === "focus.region" || request.payload.type === "screen.snapshot"
        ? request.payload.image
        : null;
    const dimensions = image ? `${image.width}x${image.height}` : "no-image";

    return {
      confidence: 0.5,
      model: "deterministic-v1",
      provider: "violet",
      summary: `Deterministic visual evidence (${dimensions}).`,
    };
  }
}
