import type { ResolvedContext } from "@violet/domain";

export function formatVisualResult(context: ResolvedContext): string {
  if (!context.answer) {
    return context.summary.includes("Selected text:")
      ? JSON.stringify({ evidence: context.summary, status: "ready" })
      : unavailable("The current view could not be understood reliably.");
  }
  if ((context.confidence ?? 0) < 0.7) {
    return unavailable("The visual model could not answer reliably.");
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
