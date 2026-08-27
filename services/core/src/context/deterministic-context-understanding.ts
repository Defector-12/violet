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
    const localText = request.localText?.trim();

    return {
      confidence: localText ? 0.95 : 0.5,
      model: "deterministic-v1",
      provider: "violet",
      summary: localText
        ? `Deterministic visual evidence (${dimensions}):\n${localText}`
        : `Deterministic visual evidence (${dimensions}) with no locally recognized text.`,
    };
  }
}
