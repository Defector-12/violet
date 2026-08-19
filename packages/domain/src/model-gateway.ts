export interface ModelMessage {
  readonly content: string;
  readonly role: "assistant" | "system" | "user";
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly requestId: string;
}

export type ModelStreamEvent =
  | {
      readonly content: string;
      readonly type: "delta";
    }
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly type: "complete";
    };

export interface ModelGateway {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
