export type RealtimeModality = "audio" | "text";
export type RealtimeRuntimeKind = "deterministic" | "integrated" | "pipeline";
export type RealtimeVoiceKind = "clone" | "none" | "parametric" | "preset";

export interface RealtimeAudioFormat {
  readonly channels: 1;
  readonly encoding: "pcm_s16le";
  readonly sampleRate: 16000 | 24000 | 48000;
}

export interface RealtimeSessionConfiguration {
  readonly inputAudio?: RealtimeAudioFormat;
  readonly inputModalities: readonly RealtimeModality[];
  readonly language?: string;
  readonly outputAudio?: RealtimeAudioFormat;
  readonly outputModalities: readonly RealtimeModality[];
  readonly voice?: string;
}

export interface RealtimeCapabilities {
  readonly inputAudio?: RealtimeAudioFormat;
  readonly inputModalities: readonly RealtimeModality[];
  readonly interruption: boolean;
  readonly outputAudio?: RealtimeAudioFormat;
  readonly outputModalities: readonly RealtimeModality[];
  readonly runtimeKind: RealtimeRuntimeKind;
  readonly transcription: boolean;
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
    };

export type RealtimeConversationOutput =
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
    };

export interface RealtimeConversation {
  readonly capabilities: RealtimeCapabilities;
  close(): Promise<void>;
  send(
    input: RealtimeConversationInput,
    signal?: AbortSignal,
  ): AsyncIterable<RealtimeConversationOutput>;
}

export interface RealtimeConversationPort {
  open(
    configuration: RealtimeSessionConfiguration,
    signal?: AbortSignal,
  ): Promise<RealtimeConversation>;
}
