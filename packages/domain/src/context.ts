export type ContextPayload =
  | {
      readonly text: string;
      readonly type: "focus.text";
    }
  | {
      readonly appBundleId: string;
      readonly appName?: string;
      readonly type: "app.state";
    }
  | {
      readonly image: ContextImage;
      readonly localText?: string;
      readonly type: "screen.snapshot";
    }
  | {
      readonly image: ContextImage;
      readonly localText?: string;
      readonly region: NormalizedRect;
      readonly type: "focus.region";
    }
  | {
      readonly transcript: string;
      readonly type: "audio.utterance";
    };

export interface ContextImage {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly sha256: string;
  readonly width: number;
}

export interface NormalizedRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface ContextUnderstandingRequest {
  readonly localText?: string;
  readonly payload: ContextPayload;
  readonly requestId: string;
}

export interface ContextUnderstandingResult {
  readonly confidence: number;
  readonly model: string;
  readonly provider: string;
  readonly summary: string;
}

export interface ContextUnderstandingPort {
  understand(
    request: ContextUnderstandingRequest,
    signal?: AbortSignal,
  ): Promise<ContextUnderstandingResult>;
}

export interface ResolvedContext {
  readonly eventId: string;
  readonly expiresAt: Date;
  readonly sessionId: string;
  readonly summary: string;
}

export interface ContextSessionRepository {
  delete(sessionId: string): Promise<void>;
  get(sessionId: string): Promise<ResolvedContext | null>;
  put(context: ResolvedContext): Promise<void>;
}

export interface ContextArtifactStore {
  deleteSession(sessionId: string): Promise<void>;
  put(input: {
    readonly bytes: Uint8Array;
    readonly eventId: string;
    readonly expiresAt: Date;
    readonly mediaType: "image/jpeg" | "image/png";
    readonly sessionId: string;
    readonly sha256: string;
  }): Promise<void>;
}
