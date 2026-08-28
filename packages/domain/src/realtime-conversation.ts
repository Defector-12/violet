export type RealtimeModality = "audio" | "text";
export type RealtimeRuntimeKind = "deterministic" | "integrated" | "pipeline";
export type RealtimeTurnDetection = "manual" | "server_vad" | "smart_turn";
export type RealtimeVoiceKind = "clone" | "none" | "parametric" | "preset";

export interface RealtimeAudioFormat {
  readonly channels: 1;
  readonly encoding: "pcm_s16le";
  readonly sampleRate: 16000 | 24000 | 48000;
}

export interface RealtimeSessionConfiguration {
  readonly contextEvidence?: string;
  readonly contextLookupAvailable?: boolean;
  readonly history?: readonly RealtimeHistoryMessage[];
  readonly inputAudio?: RealtimeAudioFormat;
  readonly inputModalities: readonly RealtimeModality[];
  readonly language?: string;
  readonly outputAudio?: RealtimeAudioFormat;
  readonly outputModalities: readonly RealtimeModality[];
  readonly turnDetection?: RealtimeTurnDetection;
  readonly voice?: string;
}

export interface RealtimeHistoryMessage {
  readonly content: string;
  readonly role: "assistant" | "user";
}

export interface RealtimeCapabilities {
  readonly inputAudio?: RealtimeAudioFormat;
  readonly inputModalities: readonly RealtimeModality[];
  readonly interruption: boolean;
  readonly outputAudio?: RealtimeAudioFormat;
  readonly outputModalities: readonly RealtimeModality[];
  readonly runtimeKind: RealtimeRuntimeKind;
  readonly transcription: boolean;
  readonly turnDetection: RealtimeTurnDetection;
  readonly voiceKind: RealtimeVoiceKind;
}

export type RealtimeConversationInput =
  | {
      readonly text: string;
      readonly turnId: string;
      readonly type: "text";
    }
  | {
      readonly audio: Uint8Array;
      readonly turnId: string;
      readonly type: "audio";
    }
  | {
      readonly turnId: string;
      readonly type: "commit";
    }
  | {
      readonly responseId: string;
      readonly type: "cancel";
    }
  | {
      readonly callId: string;
      readonly output: string;
      readonly type: "context-result";
    };

export type RealtimeConversationOutput =
  | {
      readonly turnId: string;
      readonly type: "speech-started";
    }
  | {
      readonly turnId: string;
      readonly type: "speech-stopped";
    }
  | {
      readonly final: boolean;
      readonly text: string;
      readonly turnId: string;
      readonly type: "transcript";
    }
  | {
      readonly responseId: string;
      readonly turnId: string;
      readonly type: "response-started";
    }
  | {
      readonly responseId: string;
      readonly text: string;
      readonly turnId: string;
      readonly type: "response-text";
    }
  | {
      readonly audio: Uint8Array;
      readonly responseId: string;
      readonly turnId: string;
      readonly type: "response-audio";
    }
  | {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly responseId: string;
      readonly turnId: string;
      readonly type: "response-completed";
    }
  | {
      readonly responseId: string;
      readonly type: "response-cancelled";
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly type: "error";
    }
  | {
      readonly callId: string;
      readonly query: string;
      readonly turnId: string;
      readonly type: "context-request";
    };

export interface RealtimeConversation {
  readonly capabilities: RealtimeCapabilities;
  close(): Promise<void>;
  outputs(signal?: AbortSignal): AsyncIterable<RealtimeConversationOutput>;
  send(input: RealtimeConversationInput, signal?: AbortSignal): Promise<void>;
}

export interface RealtimeConversationPort {
  readonly supportsContextLookup?: boolean;
  open(
    configuration: RealtimeSessionConfiguration,
    signal?: AbortSignal,
  ): Promise<RealtimeConversation>;
}
