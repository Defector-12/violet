import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  ContextArtifactStore,
  ContextPayload,
  ContextSessionRepository,
  ContextUnderstandingPort,
  ResolvedContext,
} from "@violet/domain";
import { evaluateContextAccess } from "@violet/policy";
import type { ContextEnvelope, ContextReceipt } from "@violet/protocol";

import { recordContextStageDuration } from "../telemetry-signals.js";

type ImageContextPayload = Extract<ContextPayload, { readonly image: unknown }>;
type ContextResolution = {
  readonly confidence: number;
  readonly model: string;
  readonly provider: string;
  readonly summary: string;
};

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
  readonly #pendingUnderstanding = new Map<
    string,
    {
      readonly abortController: AbortController;
      readonly completion: Promise<void>;
      readonly eventId: string;
    }
  >();
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
    const startedAt = performance.now();
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
    const imagePayload =
      payload.type === "focus.region" || payload.type === "screen.snapshot" ? payload : undefined;
    if (imagePayload) {
      await this.#submitImageInBackground({
        envelope,
        expiresAt,
        payload: imagePayload,
        sessionId,
        ...(signal ? { signal } : {}),
      });
    } else {
      const result = await measureContextStage("understanding", () =>
        resolvePayload(payload, envelope.eventId, this.#understanding, signal),
      );
      await this.#repository.put(
        resolvedContext({
          envelope,
          expiresAt,
          result,
          sessionId,
        }),
      );
    }
    this.#sessionVersions.set(sessionId, {
      eventId: envelope.eventId,
      sequence: envelope.sequence,
    });
    recordContextStageDuration({
      durationMs: performance.now() - startedAt,
      stage: "total",
      status: "ok",
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
    this.#pendingUnderstanding.get(canonicalSessionId)?.abortController.abort();
    this.#pendingUnderstanding.delete(canonicalSessionId);
    this.#sessionVersions.delete(canonicalSessionId);
    await Promise.all([
      this.#artifactStore.deleteSession(canonicalSessionId),
      this.#repository.delete(canonicalSessionId),
    ]);
  }

  async get(sessionId: string): Promise<ResolvedContext> {
    const canonicalSessionId = sessionId.toLowerCase();
    let context = await this.#repository.get(canonicalSessionId);
    if (!context) {
      throw new ContextServiceError("CONTEXT_NOT_FOUND", 404);
    }
    if (context.expiresAt <= this.#now()) {
      await this.delete(sessionId);
      throw new ContextServiceError("CONTEXT_EXPIRED", 410);
    }
    await this.#pendingUnderstanding.get(canonicalSessionId)?.completion;
    context = await this.#repository.get(canonicalSessionId);
    if (!context) {
      throw new ContextServiceError("CONTEXT_NOT_FOUND", 404);
    }
    return context;
  }

  async #submitImageInBackground(input: {
    readonly envelope: ContextEnvelope;
    readonly expiresAt: Date;
    readonly payload: ImageContextPayload;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.#pendingUnderstanding.get(input.sessionId)?.abortController.abort();
    const abortController = new AbortController();
    const abortFromRequest = () => abortController.abort();
    input.signal?.addEventListener("abort", abortFromRequest, { once: true });
    if (input.signal?.aborted) {
      abortController.abort();
    }
    const understanding = measureContextStage("understanding", () =>
      resolvePayload(
        input.payload,
        input.envelope.eventId,
        this.#understanding,
        abortController.signal,
      ),
    ).then(
      (result) => ({ result, status: "fulfilled" }) as const,
      () => ({ status: "rejected" }) as const,
    );
    try {
      await measureContextStage("artifact_store", () =>
        this.#artifactStore.put({
          bytes: input.payload.image.bytes,
          eventId: input.envelope.eventId,
          expiresAt: input.expiresAt,
          mediaType: input.payload.image.mediaType,
          sessionId: input.sessionId,
          sha256: input.payload.image.sha256,
        }),
      );
      if (input.signal?.aborted) {
        throw new Error("Context submission aborted");
      }
      await this.#repository.put(
        resolvedContext({
          envelope: input.envelope,
          expiresAt: input.expiresAt,
          result: localImageFallback(input.payload),
          sessionId: input.sessionId,
        }),
      );
      this.#sessionVersions.set(input.sessionId, {
        eventId: input.envelope.eventId,
        sequence: input.envelope.sequence,
      });
      const completion = understanding
        .then(async (outcome) => {
          const current = this.#sessionVersions.get(input.sessionId);
          if (outcome.status !== "fulfilled" || current?.eventId !== input.envelope.eventId) {
            return;
          }
          await this.#repository.put(
            resolvedContext({
              envelope: input.envelope,
              expiresAt: input.expiresAt,
              result: outcome.result,
              sessionId: input.sessionId,
            }),
          );
        })
        .finally(() => {
          if (this.#pendingUnderstanding.get(input.sessionId)?.eventId === input.envelope.eventId) {
            this.#pendingUnderstanding.delete(input.sessionId);
          }
        });
      this.#pendingUnderstanding.set(input.sessionId, {
        abortController,
        completion,
        eventId: input.envelope.eventId,
      });
    } catch (error) {
      abortController.abort();
      await understanding;
      await this.#artifactStore.deleteSession(input.sessionId).catch(() => {});
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abortFromRequest);
    }
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

function localImageFallback(payload: ImageContextPayload): ContextResolution {
  const localText = payload.localText?.trim();
  return {
    confidence: localText ? 0.75 : 0.25,
    model: "vision-ocr-v1",
    provider: "violet-device",
    summary: localText
      ? `Locally recognized text from the authorized image:\n${localText}`
      : "An authorized image was captured, but no local text was recognized.",
  };
}

function resolvedContext(input: {
  readonly envelope: ContextEnvelope;
  readonly expiresAt: Date;
  readonly result: ContextResolution;
  readonly sessionId: string;
}): ResolvedContext {
  return {
    eventId: input.envelope.eventId,
    expiresAt: input.expiresAt,
    sessionId: input.sessionId,
    summary: [
      `Source modality: ${input.envelope.source.modality}.`,
      input.envelope.source.appBundleId
        ? `Source application: ${input.envelope.source.appBundleId}.`
        : undefined,
      `Evidence confidence: ${Math.min(input.envelope.confidence, input.result.confidence).toFixed(
        2,
      )}.`,
      `Evidence completeness: ${input.envelope.completeness.toFixed(2)}.`,
      `Evidence resolver: ${input.result.provider}/${input.result.model}.`,
      input.result.summary,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n"),
  };
}

async function measureContextStage<T>(
  stage: "artifact_store" | "understanding",
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    recordContextStageDuration({
      durationMs: performance.now() - startedAt,
      stage,
      status: "ok",
    });
    return result;
  } catch (error) {
    recordContextStageDuration({
      durationMs: performance.now() - startedAt,
      stage,
      status: "error",
    });
    throw error;
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
