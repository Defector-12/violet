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
import { recordTestTrace } from "../realtime/test-trace.js";
import { recordContextStageDuration } from "../telemetry-signals.js";

type ImageContextPayload = Extract<ContextPayload, { readonly image: unknown }>;
type ContextResolution = {
  readonly answer?: string;
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

  async submit(
    envelope: ContextEnvelope,
    signal?: AbortSignal,
    question?: string,
  ): Promise<ContextReceipt> {
    signal?.throwIfAborted();
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
    recordTestTrace("context.access", { contextSessionId: sessionId, decision });
    if (!decision.allowed) {
      throw new ContextServiceError(decision.code, decision.status);
    }

    this.#assertSequence(envelope, sessionId);
    const payload = decodePayload(envelope.payload);
    this.#pendingUnderstanding.get(sessionId)?.abortController.abort();
    this.#pendingUnderstanding.delete(sessionId);
    this.#sessionVersions.set(sessionId, {
      eventId: envelope.eventId,
      sequence: envelope.sequence,
    });
    const imagePayload =
      payload.type === "focus.region" || payload.type === "screen.snapshot" ? payload : undefined;
    if (imagePayload) {
      await this.#submitImageInBackground({
        envelope,
        expiresAt,
        payload: imagePayload,
        ...(question ? { question } : {}),
        sessionId,
        ...(signal ? { signal } : {}),
      });
    } else {
      const result = await measureContextStage("understanding", () =>
        resolvePayload(payload, envelope.eventId, this.#understanding, signal, question),
      );
      this.#assertCurrent(envelope.eventId, sessionId, expiresAt, signal);
      await this.#repository.put(
        resolvedContext({
          envelope,
          expiresAt,
          result,
          sessionId,
        }),
      );
    }
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
    await this.#getAvailable(canonicalSessionId);
    await this.#pendingUnderstanding.get(canonicalSessionId)?.completion;
    return this.#getAvailable(canonicalSessionId);
  }

  async getAvailable(sessionId: string): Promise<ResolvedContext> {
    return this.#getAvailable(sessionId.toLowerCase());
  }

  async #getAvailable(canonicalSessionId: string): Promise<ResolvedContext> {
    const context = await this.#repository.get(canonicalSessionId);
    if (!context) {
      throw new ContextServiceError("CONTEXT_NOT_FOUND", 404);
    }
    if (context.expiresAt <= this.#now()) {
      await this.delete(canonicalSessionId);
      throw new ContextServiceError("CONTEXT_EXPIRED", 410);
    }
    return context;
  }

  async #submitImageInBackground(input: {
    readonly envelope: ContextEnvelope;
    readonly expiresAt: Date;
    readonly payload: ImageContextPayload;
    readonly question?: string;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
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
        input.question,
      ),
    ).then(
      (result) => ({ result, status: "fulfilled" }) as const,
      () => ({ status: "rejected" }) as const,
    );
    // Register work before waiting for storage so deletion can cancel an in-flight upload.
    const stored = (async () => {
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
      this.#assertCurrent(
        input.envelope.eventId,
        input.sessionId,
        input.expiresAt,
        abortController.signal,
      );
      await this.#repository.put(
        resolvedContext({
          envelope: input.envelope,
          expiresAt: input.expiresAt,
          result: localImageFallback(input.payload),
          sessionId: input.sessionId,
        }),
      );
    })();
    const completion = Promise.all([understanding, stored])
      .then(async ([outcome]) => {
        const current = this.#sessionVersions.get(input.sessionId);
        if (
          outcome.status !== "fulfilled" ||
          abortController.signal.aborted ||
          current?.eventId !== input.envelope.eventId ||
          input.expiresAt <= this.#now()
        ) {
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
      .catch(() => undefined)
      .finally(() => {
        input.signal?.removeEventListener("abort", abortFromRequest);
        if (this.#pendingUnderstanding.get(input.sessionId)?.eventId === input.envelope.eventId) {
          this.#pendingUnderstanding.delete(input.sessionId);
        }
      });
    this.#pendingUnderstanding.set(input.sessionId, {
      abortController,
      completion,
      eventId: input.envelope.eventId,
    });
    try {
      await stored;
    } catch (error) {
      abortController.abort();
      const current = this.#sessionVersions.get(input.sessionId);
      if (!current || current.eventId === input.envelope.eventId) {
        await this.delete(input.sessionId);
      }
      throw error;
    }
  }

  #assertCurrent(eventId: string, sessionId: string, expiresAt: Date, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#sessionVersions.get(sessionId)?.eventId !== eventId) {
      throw new ContextServiceError("CONTEXT_NOT_FOUND", 404);
    }
    if (expiresAt <= this.#now()) {
      throw new ContextServiceError("CONTEXT_EXPIRED", 410);
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

function localImageFallback(_payload: ImageContextPayload): ContextResolution {
  return {
    confidence: 0.25,
    model: "pending-v1",
    provider: "violet-device",
    summary: "An authorized image was captured and is awaiting visual understanding.",
  };
}

function resolvedContext(input: {
  readonly envelope: ContextEnvelope;
  readonly expiresAt: Date;
  readonly result: ContextResolution;
  readonly sessionId: string;
}): ResolvedContext {
  return {
    ...(input.result.answer ? { answer: input.result.answer } : {}),
    confidence: Math.min(input.envelope.confidence, input.result.confidence),
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
  recordTestTrace("context.stage.started", { stage });
  try {
    const result = await operation();
    recordContextStageDuration({
      durationMs: performance.now() - startedAt,
      stage,
      status: "ok",
    });
    recordTestTrace("context.stage.completed", { stage, elapsedMs: performance.now() - startedAt });
    return result;
  } catch (error) {
    recordTestTrace("context.stage.failed", {
      stage,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : "unknown",
    });
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
        ...(payload.focusPoint ? { focusPoint: payload.focusPoint } : {}),
        image,
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
        ...(payload.focusPoint ? { focusPoint: payload.focusPoint } : {}),
        image,
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
  question?: string,
): Promise<{
  readonly answer?: string;
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
    case "screen.snapshot": {
      const result = await understanding.understand(
        {
          payload,
          ...(question ? { question } : {}),
          requestId,
        },
        signal,
      );
      return result;
    }
  }
}
