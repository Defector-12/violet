import { createHash, randomUUID } from "node:crypto";
import type { ContextUnderstandingRequest } from "@violet/domain";
import type { ContextEnvelope } from "@violet/protocol";
import { describe, expect, it, vi } from "vitest";

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
          type: "screen.snapshot",
        },
        sessionId,
      }),
    );
    const resolved = await service.get(sessionId);

    expect(receipt.status).toBe("ready");
    expect(resolved.summary).toContain("200x100");
    expect(JSON.stringify(resolved)).not.toContain(bytes.toString("base64"));
  });

  it("preserves a question-grounded answer", async () => {
    const bytes = Buffer.from("synthetic-image");
    const sessionId = randomUUID();
    const service = new ContextService({
      artifactStore: new InMemoryContextArtifactStore(),
      now: () => now,
      repository: new InMemoryContextSessionRepository(),
      understanding: {
        async understand(request) {
          expect(request.question).toBe("右下角绿色按钮有什么作用？");
          return {
            answer: "右下角绿色按钮用于发送消息。",
            confidence: 0.95,
            model: "test",
            provider: "test",
            summary: "右下角绿色按钮用于发送消息。",
          };
        },
      },
    });

    await service.submit(
      envelope({
        payload: {
          image: {
            data: bytes.toString("base64"),
            height: 100,
            mediaType: "image/jpeg",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            width: 200,
          },
          type: "screen.snapshot",
        },
        sessionId,
      }),
      undefined,
      "右下角绿色按钮有什么作用？",
    );

    await expect(service.get(sessionId)).resolves.toMatchObject({
      answer: "右下角绿色按钮用于发送消息。",
      confidence: 0.9,
    });
  });

  it("canonicalizes UUID casing across context requests", async () => {
    const service = createService();
    const uppercaseSessionId = randomUUID().toUpperCase();

    const receipt = await service.submit(envelope({ sessionId: uppercaseSessionId }));
    const resolved = await service.get(uppercaseSessionId.toLowerCase());

    expect(receipt.sessionId).toBe(uppercaseSessionId.toLowerCase());
    expect(resolved.sessionId).toBe(uppercaseSessionId.toLowerCase());
  });

  it("returns after encrypted storage while image understanding continues", async () => {
    const events: string[] = [];
    const bytes = Buffer.from("synthetic-image");
    let finishUnderstanding: (() => void) | undefined;
    const service = new ContextService({
      artifactStore: {
        async deleteSession() {},
        async put() {
          events.push("storage-started");
        },
      },
      now: () => now,
      repository: new InMemoryContextSessionRepository(),
      understanding: {
        async understand() {
          events.push("understanding-started");
          await new Promise<void>((resolve) => {
            finishUnderstanding = resolve;
          });
          events.push("understanding-finished");
          return {
            confidence: 1,
            model: "test",
            provider: "test",
            summary: "Synthetic image",
          };
        },
      },
    });

    const receipt = await service.submit(
      envelope({
        payload: {
          image: {
            data: bytes.toString("base64"),
            height: 100,
            mediaType: "image/jpeg",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            width: 200,
          },
          type: "screen.snapshot",
        },
      }),
    );

    expect(receipt.status).toBe("ready");
    expect(events).toEqual(["understanding-started", "storage-started"]);
    const available = await service.getAvailable(receipt.sessionId);
    expect(available.summary).toContain("awaiting visual understanding");
    let questionUnblocked = false;
    const resolvedContext = service.get(receipt.sessionId).then((resolved) => {
      questionUnblocked = true;
      return resolved;
    });
    await Promise.resolve();
    expect(questionUnblocked).toBe(false);
    finishUnderstanding?.();
    const resolved = await resolvedContext;
    expect(resolved.summary).toContain("Synthetic image");
    expect(events).toEqual(["understanding-started", "storage-started", "understanding-finished"]);
  });

  it("returns an unavailable image placeholder when visual understanding fails", async () => {
    const deletedSessions: string[] = [];
    const bytes = Buffer.from("synthetic-image");
    const sessionId = randomUUID();
    const service = new ContextService({
      artifactStore: {
        async deleteSession(deletedSessionId) {
          deletedSessions.push(deletedSessionId);
        },
        async put() {},
      },
      now: () => now,
      repository: new InMemoryContextSessionRepository(),
      understanding: {
        async understand() {
          throw new Error("vision failed");
        },
      },
    });

    const receipt = await service.submit(
      envelope({
        payload: {
          image: {
            data: bytes.toString("base64"),
            height: 100,
            mediaType: "image/jpeg",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            width: 200,
          },
          type: "screen.snapshot",
        },
        sessionId,
      }),
    );
    const resolved = await service.get(receipt.sessionId);

    expect(resolved.summary).toContain("awaiting visual understanding");
    expect(resolved.summary).toContain("violet-device/pending-v1");
    expect(deletedSessions).toEqual([]);

    await service.delete(sessionId);
    expect(deletedSessions).toEqual([sessionId]);
  });

  it("cancels background understanding when the session is deleted", async () => {
    let aborted = false;
    const bytes = Buffer.from("synthetic-image");
    const service = new ContextService({
      artifactStore: new InMemoryContextArtifactStore(),
      now: () => now,
      repository: new InMemoryContextSessionRepository(),
      understanding: {
        async understand(_request, signal) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
      },
    });
    const receipt = await service.submit(
      envelope({
        payload: {
          image: {
            data: bytes.toString("base64"),
            height: 100,
            mediaType: "image/jpeg",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            width: 200,
          },
          type: "screen.snapshot",
        },
      }),
    );

    await service.delete(receipt.sessionId);

    expect(aborted).toBe(true);
    await expect(service.get(receipt.sessionId)).rejects.toMatchObject({
      code: "CONTEXT_NOT_FOUND",
    });
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

  describe("in-flight lifecycle", () => {
    function fixture(delayStorage = false) {
      let finish = () => {};
      let stored = () => {};
      const vision = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const storage = new Promise<void>((resolve) => {
        stored = resolve;
      });
      const repository = new InMemoryContextSessionRepository();
      const put = vi.spyOn(repository, "put");
      const deleteSession = vi.fn(async () => {});
      let signal: AbortSignal | undefined;
      const understand = vi.fn(
        async (_request: ContextUnderstandingRequest, incomingSignal?: AbortSignal) => {
          signal = incomingSignal;
          await vision;
          return { confidence: 1, model: "test", provider: "test", summary: "Late image answer" };
        },
      );
      let clock = now;
      const artifactPut = vi.fn(async () => {
        if (delayStorage) await storage;
      });
      const service = new ContextService({
        artifactStore: { put: artifactPut, deleteSession },
        now: () => clock,
        repository,
        understanding: { understand },
      });
      const bytes = Buffer.from("synthetic lifecycle image");
      const image = envelope({
        payload: {
          type: "screen.snapshot",
          image: {
            data: bytes.toString("base64"),
            width: 1,
            height: 1,
            mediaType: "image/png",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      });
      return {
        service,
        image,
        put,
        artifactPut,
        deleteSession,
        understand,
        signal: () => signal,
        finish,
        stored,
        expire: () => {
          clock = new Date(now.getTime() + 300_001);
        },
      };
    }

    it("propagates cancellation after upload and rejects a late model write", async () => {
      const f = fixture();
      const controller = new AbortController();
      try {
        await f.service.submit(f.image, controller.signal);
        controller.abort();
        expect(f.signal()?.aborted).toBe(true);
        f.finish();
        await f.service.get(f.image.sessionId).catch(() => undefined);
        expect(f.put.mock.calls.some(([c]) => c.summary.includes("Late image answer"))).toBe(false);
      } finally {
        f.finish();
        await f.service.delete(f.image.sessionId);
      }
    });

    it.each(["text", "image"] as const)("cancels an image when replaced by %s", async (kind) => {
      const f = fixture();
      try {
        await f.service.submit(f.image);
        const oldSignal = f.signal();
        const replacement = {
          ...f.image,
          eventId: randomUUID(),
          previousEventId: f.image.eventId,
          sequence: 2,
          payload:
            kind === "text" ? { type: "focus.text" as const, text: "New text" } : f.image.payload,
        };
        await f.service.submit(replacement);
        expect(oldSignal?.aborted).toBe(true);
        f.finish();
        expect((await f.service.get(f.image.sessionId)).eventId).toBe(replacement.eventId);
        expect(
          f.put.mock.calls
            .filter(([c]) => c.summary.includes("Late image answer"))
            .every(([c]) => c.eventId === replacement.eventId),
        ).toBe(true);
      } finally {
        f.finish();
        await f.service.delete(f.image.sessionId);
      }
    });

    it("deleting during upload prevents a late submission from recreating context", async () => {
      const f = fixture(true);
      const submitted = f.service.submit(f.image).then(
        () => "accepted",
        () => "rejected",
      );
      try {
        await f.service.delete(f.image.sessionId);
        expect(f.signal()?.aborted).toBe(true);
        f.stored();
        f.finish();
        expect(await submitted).toBe("rejected");
        expect(f.put).not.toHaveBeenCalled();
        await expect(f.service.get(f.image.sessionId)).rejects.toMatchObject({
          code: "CONTEXT_NOT_FOUND",
        });
        expect(f.deleteSession).toHaveBeenCalled();
      } finally {
        f.stored();
        f.finish();
        await submitted;
        await f.service.delete(f.image.sessionId);
      }
    });

    it("does not publish a model result that expired while understanding was running", async () => {
      const f = fixture();
      try {
        await f.service.submit(f.image);
        const resolved = f.service.get(f.image.sessionId).then(
          () => "accepted",
          () => "rejected",
        );
        f.expire();
        f.finish();
        expect(await resolved).toBe("rejected");
        expect(f.put.mock.calls.some(([c]) => c.summary.includes("Late image answer"))).toBe(false);
      } finally {
        f.finish();
        await f.service.delete(f.image.sessionId);
      }
    });

    it("does not start storage or vision for an already cancelled request", async () => {
      const f = fixture();
      const controller = new AbortController();
      controller.abort();
      f.finish();
      await expect(f.service.submit(f.image, controller.signal)).rejects.toThrow();
      expect(f.understand).not.toHaveBeenCalled();
      expect(f.artifactPut).not.toHaveBeenCalled();
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
