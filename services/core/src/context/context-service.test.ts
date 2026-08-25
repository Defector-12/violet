import { createHash, randomUUID } from "node:crypto";
import type { ContextEnvelope } from "@violet/protocol";
import { describe, expect, it } from "vitest";

import { ContextService, ContextServiceError } from "./context-service.js";
import { DeterministicContextUnderstandingPort } from "./deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "./in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "./in-memory-context-session-repository.js";

const now = new Date("2026-08-24T00:00:00.000Z");

describe("ContextService", () => {
  it("resolves a verified image without retaining its bytes", async () => {
    const service = createService();
    const sessionId = randomUUID();
    const bytes = Buffer.from("synthetic-image");

    const receipt = await service.submit(
      envelope({
        payload: {
          image: {
            data: bytes.toString("base64"),
            height: 100,
            mediaType: "image/png",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            width: 200,
          },
          localText: "Architecture diagram",
          type: "screen.snapshot",
        },
        sessionId,
      }),
    );
    const resolved = await service.get(sessionId);

    expect(receipt.status).toBe("ready");
    expect(resolved.summary).toContain("Architecture diagram");
    expect(JSON.stringify(resolved)).not.toContain(bytes.toString("base64"));
  });

  it("canonicalizes UUID casing across context requests", async () => {
    const service = createService();
    const uppercaseSessionId = randomUUID().toUpperCase();

    const receipt = await service.submit(envelope({ sessionId: uppercaseSessionId }));
    const resolved = await service.get(uppercaseSessionId.toLowerCase());

    expect(receipt.sessionId).toBe(uppercaseSessionId.toLowerCase());
    expect(resolved.sessionId).toBe(uppercaseSessionId.toLowerCase());
  });

  it("rejects modified image bytes", async () => {
    const service = createService();

    await expect(
      service.submit(
        envelope({
          payload: {
            image: {
              data: Buffer.from("modified").toString("base64"),
              height: 1,
              mediaType: "image/png",
              sha256: "a".repeat(64),
              width: 1,
            },
            type: "screen.snapshot",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONTEXT_HASH_MISMATCH",
      status: 400,
    });
  });

  it("rejects expired, unauthorized, and out-of-order context", async () => {
    const service = createService();
    const sessionId = randomUUID();

    await expect(
      service.submit(
        envelope({
          expiresAt: now.toISOString(),
          sessionId,
        }),
      ),
    ).rejects.toBeInstanceOf(ContextServiceError);
    await expect(
      service.submit(
        envelope({
          controlledSensitiveAllowed: false,
          sensitivity: "controlled",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_NOT_AUTHORIZED" });
    await expect(
      service.submit(
        envelope({
          sequence: 2,
          sessionId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_SEQUENCE_INVALID" });
  });

  it("deletes an active context immediately", async () => {
    const service = createService();
    const sessionId = randomUUID();
    await service.submit(envelope({ sessionId }));

    await service.delete(sessionId);

    await expect(service.get(sessionId)).rejects.toMatchObject({
      code: "CONTEXT_NOT_FOUND",
      status: 404,
    });
  });
});

function createService(): ContextService {
  return new ContextService({
    artifactStore: new InMemoryContextArtifactStore(),
    now: () => now,
    repository: new InMemoryContextSessionRepository(),
    understanding: new DeterministicContextUnderstandingPort(),
  });
}

function envelope(
  overrides: {
    readonly controlledSensitiveAllowed?: boolean;
    readonly expiresAt?: string;
    readonly payload?: ContextEnvelope["payload"];
    readonly sensitivity?: ContextEnvelope["sensitivity"];
    readonly sequence?: number;
    readonly sessionId?: string;
  } = {},
): ContextEnvelope {
  return {
    authorization: {
      controlledSensitiveAllowed: overrides.controlledSensitiveAllowed ?? false,
      grantId: randomUUID(),
      mode: "explicit",
      purpose: "conversation",
      retention: "ephemeral",
    },
    capturedAt: now.toISOString(),
    completeness: 1,
    confidence: 0.9,
    eventId: randomUUID(),
    expiresAt: overrides.expiresAt ?? new Date(now.getTime() + 300_000).toISOString(),
    payload: overrides.payload ?? {
      text: "Selected text",
      type: "focus.text",
    },
    protocolVersion: "1",
    redactions: [],
    sensitivity: overrides.sensitivity ?? "personal",
    sequence: overrides.sequence ?? 1,
    sessionId: overrides.sessionId ?? randomUUID(),
    source: {
      deviceId: randomUUID(),
      modality: "accessibility",
    },
  };
}
