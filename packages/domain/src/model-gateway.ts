export interface ModelMessage {
  readonly content: string;
  readonly role: "assistant" | "system" | "user" | "tool";
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly maximumOutputTokens?: number;
  readonly messages: readonly ModelMessage[];
  readonly requestId: string;
  readonly thinking?: boolean;
  readonly jsonOutput?: boolean;
  readonly tools?: readonly ModelTool[];
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
      readonly toolCalls?: readonly ModelToolCall[];
    };

export interface ModelGateway {
  readonly contextProfile?: ModelContextProfile;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
