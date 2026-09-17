export interface ModelMessage {
  readonly content: string;
  readonly role: "assistant" | "system" | "user";
}

export interface ModelRequest {
  readonly maximumOutputTokens?: number;
  readonly messages: readonly ModelMessage[];
  readonly requestId: string;
  readonly thinking?: boolean;
}

export interface ModelContextProfile {
  readonly contextWindowTokens: number;
  readonly estimateTokens: (messages: readonly ModelMessage[]) => number;
  readonly maximumOutputTokens?: number;
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
  readonly contextProfile?: ModelContextProfile;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
