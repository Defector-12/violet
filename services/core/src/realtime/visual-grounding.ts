import type { ResolvedContext } from "@violet/domain";

export function formatVisualResult(context: ResolvedContext): string {
  if ((context.confidence ?? 0) < 0.7) {
    return unavailable("The visual model could not answer reliably.");
  }
  if (!context.answer) {
    return JSON.stringify({
      confidence: context.confidence,
      evidence: context.summary,
      status: "ready",
    });
  }
  return JSON.stringify({
    answer: context.answer,
    confidence: context.confidence,
    status: "ready",
  });
}

function unavailable(message: string): string {
  return JSON.stringify({ message, status: "unavailable" });
}
