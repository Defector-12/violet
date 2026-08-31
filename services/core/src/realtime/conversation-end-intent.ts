import type { ModelGateway } from "@violet/domain";

export interface ConversationEndIntentPort {
  shouldEnd(
    input: { readonly text: string; readonly turnId: string },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export class ModelConversationEndIntent implements ConversationEndIntentPort {
  readonly #modelGateway: ModelGateway;

  constructor(modelGateway: ModelGateway) {
    this.#modelGateway = modelGateway;
  }

  async shouldEnd(
    input: { readonly text: string; readonly turnId: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    let result = "";
    for await (const event of this.#modelGateway.stream(
      {
        messages: [
          {
            content: [
              "Classify whether the user clearly intends to end the current live conversation now.",
              "Reply with exactly END or CONTINUE.",
              "Use END for direct farewells or statements that the conversation is finished for now.",
              "Use CONTINUE for questions, quoted speech, hypotheticals, negations, or discussion about ending conversations.",
            ].join(" "),
            role: "system",
          },
          {
            content: input.text,
            role: "user",
          },
        ],
        requestId: input.turnId,
      },
      signal,
    )) {
      if (event.type === "delta") {
        result += event.content;
      }
    }
    return result.trim().toUpperCase() === "END";
  }
}
