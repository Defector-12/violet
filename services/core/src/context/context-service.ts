import { createHash } from "node:crypto";
import type {
  ContextArtifactStore,
  ContextPayload,
  ContextSessionRepository,
  ContextUnderstandingPort,
  ResolvedContext,
} from "@violet/domain";
import { evaluateContextAccess } from "@violet/policy";
import type { ContextEnvelope, ContextReceipt } from "@violet/protocol";

export class ContextServiceError extends Error {
  constructor(
    readonly code:
      | "CONTEXT_EXPIRED"
      | "CONTEXT_HASH_MISMATCH"
      | "CONTEXT_LIFETIME_EXCEEDED"
      | "CONTEXT_NOT_AUTHORIZED"
      | "CONTEXT_NOT_FOUND"
      | "CONTEXT_PAYLOAD_INVALID"
      | "CONTEXT_SEQUENCE_INVALID"
      | "CONTEXT_TIMESTAMP_INVALID",
    readonly status: 400 | 404 | 410,
  ) {
    super(code);
    this.name = "ContextServiceError";
  }
}

export class ContextService {
  readonly #now: () => Date;
  readonly #artifactStore: ContextArtifactStore;
  readonly #repository: ContextSessionRepository;
  readonly #understanding: ContextUnderstandingPort;
  readonly #sessionVersions = new Map<
    string,
    { readonly eventId: string; readonly sequence: number }
  >();

  constructor(input: {
    readonly artifactStore: ContextArtifactStore;
    readonly now?: () => Date;
    readonly repository: ContextSessionRepository;
    readonly understanding: ContextUnderstandingPort;
  }) {
    this.#artifactStore = input.artifactStore;
    this.#now = input.now ?? (() => new Date());
    this.#repository = input.repository;
    this.#understanding = input.understanding;
  }

  async submit(envelope: ContextEnvelope, signal?: AbortSignal): Promise<ContextReceipt> {
    const now = this.#now();
    const capturedAt = new Date(envelope.capturedAt);
    const expiresAt = new Date(envelope.expiresAt);
    const sessionId = envelope.sessionId.toLowerCase();
    const decision = evaluateContextAccess({
      capturedAt,
      controlledSensitiveAllowed: envelope.authorization.controlledSensitiveAllowed,
      expiresAt,
      now,
      sensitivity: envelope.sensitivity,
    });
    if (!decision.allowed) {
      throw new ContextServiceError(decision.code, decision.status);
    }

    this.#assertSequence(envelope, sessionId);
    const payload = decodePayload(envelope.payload);
    const result = await resolvePayload(payload, envelope.eventId, this.#understanding, signal);
    if (payload.type === "focus.region" || payload.type === "screen.snapshot") {
      await this.#artifactStore.put({
        bytes: payload.image.bytes,
        eventId: envelope.eventId,
        expiresAt,
        mediaType: payload.image.mediaType,
        sessionId,
        sha256: payload.image.sha256,
      });
    }
    const resolved: ResolvedContext = {
      eventId: envelope.eventId,
      expiresAt,
      sessionId,
      summary: [
        `Source modality: ${envelope.source.modality}.`,
        envelope.source.appBundleId
          ? `Source application: ${envelope.source.appBundleId}.`
          : undefined,
        `Evidence confidence: ${Math.min(envelope.confidence, result.confidence).toFixed(2)}.`,
        `Evidence completeness: ${envelope.completeness.toFixed(2)}.`,
        `Evidence resolver: ${result.provider}/${result.model}.`,
        result.summary,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n"),
    };
    await this.#repository.put(resolved);
    this.#sessionVersions.set(sessionId, {
      eventId: envelope.eventId,
      sequence: envelope.sequence,
    });

    return {
      acceptedAt: now.toISOString(),
      eventId: envelope.eventId,
      expiresAt: envelope.expiresAt,
      sessionId,
      status: "ready",
    };
  }

  async delete(sessionId: string): Promise<void> {
    const canonicalSessionId = sessionId.toLowerCase();
    this.#sessionVersions.delete(canonicalSessionId);
    await Promise.all([
      this.#artifactStore.deleteSession(canonicalSessionId),
      this.#repository.delete(canonicalSessionId),
    ]);
  }

  async get(sessionId: string): Promise<ResolvedContext> {
    const canonicalSessionId = sessionId.toLowerCase();
    const context = await this.#repository.get(canonicalSessionId);
    if (!context) {
      throw new ContextServiceError("CONTEXT_NOT_FOUND", 404);
    }
    if (context.expiresAt <= this.#now()) {
      await this.delete(sessionId);
      throw new ContextServiceError("CONTEXT_EXPIRED", 410);
    }
    return context;
  }

  #assertSequence(envelope: ContextEnvelope, sessionId: string): void {
    const current = this.#sessionVersions.get(sessionId);
    if (!current) {
      if (envelope.sequence !== 1 || envelope.previousEventId !== undefined) {
        throw new ContextServiceError("CONTEXT_SEQUENCE_INVALID", 400);
      }
      return;
    }
    if (
      envelope.sequence !== current.sequence + 1 ||
      envelope.previousEventId !== current.eventId
    ) {
      throw new ContextServiceError("CONTEXT_SEQUENCE_INVALID", 400);
    }
  }
}

function decodePayload(payload: ContextEnvelope["payload"]): ContextPayload {
  switch (payload.type) {
    case "focus.text":
      return payload;
    case "app.state":
      return {
        appBundleId: payload.appBundleId,
        ...(payload.appName ? { appName: payload.appName } : {}),
        type: payload.type,
      };
    case "audio.utterance":
      return payload;
    case "screen.snapshot": {
      const image = decodeImage(payload.image);
      return {
        image,
        ...(payload.localText !== undefined ? { localText: payload.localText } : {}),
        type: payload.type,
      };
    }
    case "focus.region": {
      const image = decodeImage(payload.image);
      if (
        payload.region.x + payload.region.width > 1 ||
        payload.region.y + payload.region.height > 1
      ) {
        throw new ContextServiceError("CONTEXT_PAYLOAD_INVALID", 400);
      }
      return {
        image,
        ...(payload.localText !== undefined ? { localText: payload.localText } : {}),
        region: payload.region,
        type: payload.type,
      };
    }
  }
}

function decodeImage(image: {
  readonly data: string;
  readonly height: number;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly sha256: string;
  readonly width: number;
}): {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly sha256: string;
  readonly width: number;
} {
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
    throw new ContextServiceError("CONTEXT_PAYLOAD_INVALID", 400);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== image.sha256) {
    throw new ContextServiceError("CONTEXT_HASH_MISMATCH", 400);
  }
  return {
    bytes,
    height: image.height,
    mediaType: image.mediaType,
    sha256: image.sha256,
    width: image.width,
  };
}

async function resolvePayload(
  payload: ContextPayload,
  requestId: string,
  understanding: ContextUnderstandingPort,
  signal?: AbortSignal,
): Promise<{
  readonly confidence: number;
  readonly model: string;
  readonly provider: string;
  readonly summary: string;
}> {
  switch (payload.type) {
    case "focus.text":
      return {
        confidence: 1,
        model: "accessibility-v1",
        provider: "violet-device",
        summary: `Selected text:\n${payload.text}`,
      };
    case "app.state":
      return {
        confidence: 1,
        model: "application-state-v1",
        provider: "violet-device",
        summary: `Current application: ${payload.appName ?? payload.appBundleId}.`,
      };
    case "audio.utterance":
      return {
        confidence: 1,
        model: "transcript-v1",
        provider: "violet-device",
        summary: `Current utterance:\n${payload.transcript}`,
      };
    case "focus.region":
    case "screen.snapshot":
      return understanding.understand(
        {
          ...(payload.localText !== undefined ? { localText: payload.localText } : {}),
          payload,
          requestId,
        },
        signal,
      );
  }
}
