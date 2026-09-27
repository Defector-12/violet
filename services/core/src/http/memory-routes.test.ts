import { createHash, randomUUID } from "node:crypto";
import { MemoryConflictError, type MemoryRepository } from "@violet/domain";
import { type ApiError, assertChatStreamEvent } from "@violet/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceAuthenticator, hashDeviceToken } from "../auth/device-authenticator.js";
import { ContextEpochManager } from "../conversation/context-epoch-manager.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { MemoryService } from "../memory/memory-service.js";
import { registerMemoryRoutes } from "./memory-routes.js";

const deviceToken = "synthetic-memory-route-device-value-at-least-32-characters";
const memoryId = "11111111-1111-4111-8111-111111111111";
const deletionId = "22222222-2222-4222-8222-222222222222";
const instanceId = "33333333-3333-4333-8333-333333333333";
const privateMarker = "synthetic-private-content-not-for-error-responses";
const correction = { requestId: randomUUID(), expectedVersion: 1, content: "Prefer violet" };
const confirmation = { instanceId, minimumRestoreEpoch: 1 };
const correctionPath = `/v1/memories/${memoryId}/corrections`;
const confirmPath = `/v1/memory-deletions/${deletionId}/confirm`;
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Memory HTTP error contract", () => {
  it.each([
    {
      name: "unauthenticated",
      authenticated: false,
      sealed: false,
      status: 401,
      code: "UNAUTHENTICATED",
      retryable: false,
    },
    {
      name: "sealed",
      authenticated: true,
      sealed: true,
      status: 423,
      code: "CORE_SEALED",
      retryable: true,
    },
    {
      name: "unavailable",
      authenticated: true,
      sealed: false,
      status: 503,
      code: "MEMORY_UNAVAILABLE",
      retryable: true,
    },
  ])("returns complete $name errors on every memory route", async (access) => {
    const { baseUrl } = await startMemoryRoutes({ sealed: access.sealed, unavailable: true });
    for (const [method, path, body] of [
      ["GET", "/v1/memories", undefined],
      ["GET", `/v1/memories/${memoryId}`, undefined],
      ["POST", correctionPath, correction],
      ["POST", "/v1/memory-deletions/previews", { id: deletionId, target: { kind: "all" } }],
      ["GET", `/v1/memory-deletions/${deletionId}/preview`, undefined],
      ["POST", confirmPath, confirmation],
      ["GET", `/v1/memory-deletions/${deletionId}`, undefined],
      ["POST", `/v1/memory-deletions/${deletionId}/retry`, undefined],
    ] as const) {
      const response = await send(baseUrl, path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        authenticated: access.authenticated,
      });
      assertError(response, access.status, access.code, access.retryable);
    }
  });

  it.each([
    ["GET", `/v1/memories/${memoryId}`],
    ["GET", `/v1/memory-deletions/${deletionId}/preview`],
    ["GET", `/v1/memory-deletions/${deletionId}`],
    ["POST", `/v1/memory-deletions/${deletionId}/retry`],
  ] as const)("returns a complete not-found error for %s %s", async (method, path) => {
    const { baseUrl } = await startMemoryRoutes();
    assertError(await send(baseUrl, path, { method }), 404, "MEMORY_NOT_FOUND", false);
  });

  it("returns a correlated conflict for a stale correction version", async () => {
    const { baseUrl, repository } = await startMemoryRoutes();
    const response = await send(baseUrl, correctionPath, {
      method: "POST",
      body: JSON.stringify(correction),
    });
    assertError(response, 409, "MEMORY_CONFLICT", true);
    expect(repository.write).not.toHaveBeenCalled();
  });

  it("returns a complete conflict from deletion confirmation", async () => {
    const { baseUrl, repository } = await startMemoryRoutes();
    vi.spyOn(repository, "confirmDeletion").mockRejectedValue(
      new MemoryConflictError("Deletion impact changed; refresh the preview"),
    );
    const response = await send(baseUrl, confirmPath, {
      method: "POST",
      body: JSON.stringify(confirmation),
    });
    assertError(response, 409, "MEMORY_CONFLICT", true);
    expect(repository.confirmDeletion).toHaveBeenCalledWith({
      id: deletionId,
      ...confirmation,
      deviceId: createHash("sha256").update(`Bearer ${deviceToken}`).digest("hex"),
    });
  });

  it.each([correctionPath, "/v1/memory-deletions/previews", confirmPath])(
    "returns a complete validation error for %s",
    async (path) => {
      const { baseUrl } = await startMemoryRoutes();
      assertError(
        await send(baseUrl, path, {
          method: "POST",
          body: JSON.stringify({ content: privateMarker }),
        }),
        400,
        "INVALID_MEMORY_REQUEST",
        false,
      );
    },
  );

  it("rejects an invalid source ID without echoing it", async () => {
    const { baseUrl } = await startMemoryRoutes();
    assertError(
      await send(baseUrl, `/v1/memories/${privateMarker}`),
      400,
      "INVALID_MEMORY_REQUEST",
      false,
    );
  });

  it("rejects credential-shaped synthetic content without echoing it", async () => {
    const { baseUrl } = await startMemoryRoutes();
    assertError(
      await send(baseUrl, correctionPath, {
        method: "POST",
        body: JSON.stringify({ ...correction, content: `password=${privateMarker}` }),
      }),
      400,
      "MEMORY_SECRET_REJECTED",
      false,
    );
  });

  it.each([
    {
      name: "Error with an unrelated statusCode",
      failure: Object.assign(new Error(privateMarker), { statusCode: 400 }),
    },
    { name: "non-Error rejection", failure: privateMarker },
  ])("sanitizes an internal $name as retryable 500", async ({ failure }) => {
    const { baseUrl, repository } = await startMemoryRoutes();
    vi.spyOn(repository, "snapshot").mockRejectedValue(failure);
    const response = await send(baseUrl, "/v1/memories");
    assertError(response, 500, "MEMORY_UNAVAILABLE", true);
    expect(response.body.message).toBe("Memory operation failed");
  });

  it.each([
    { name: "invalid JSON", body: "{", contentType: "application/json", status: 400 },
    {
      name: "invalid JSON with private text",
      body: `{"content":"${privateMarker}"`,
      contentType: "application/json",
      status: 400,
    },
    { name: "empty JSON", body: "", contentType: "application/json", status: 400 },
    {
      name: "oversized JSON",
      body: JSON.stringify({ content: privateMarker.repeat(25) }),
      contentType: "application/json",
      status: 413,
    },
    {
      name: "unsupported media type",
      body: privateMarker,
      contentType: `application/x-${privateMarker}`,
      status: 415,
    },
  ])(
    "preserves non-retryable $status for $name before preHandler",
    async ({ body, contentType, status }) => {
      const { baseUrl, repository } = await startMemoryRoutes();
      const response = await send(baseUrl, correctionPath, { method: "POST", body, contentType });
      assertError(response, status, "INVALID_MEMORY_REQUEST", false);
      expect(repository.snapshot).not.toHaveBeenCalled();
      expect(repository.write).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "invalid-id", "-".repeat(36), "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"])(
    "uses a schema-valid request ID for header %s",
    async (requestId) => {
      const { baseUrl } = await startMemoryRoutes({ unavailable: true });
      const response = await send(baseUrl, "/v1/memories", { requestId });
      assertError(response, 503, "MEMORY_UNAVAILABLE", true);
      if (requestId?.startsWith("ABCDEF")) {
        expect(response.body.requestId).toBe(requestId);
      } else {
        expect(response.body.requestId).not.toBe(requestId);
      }
    },
  );
});

async function startMemoryRoutes(options: { sealed?: boolean; unavailable?: boolean } = {}) {
  const state = { instanceId, revision: 2, deletionRevision: 0, restoreEpoch: 0 };
  const unexpected = vi.fn(async (): Promise<never> => {
    throw new Error("Unexpected repository access");
  });
  // Keep persistence local; parsing, authentication, service checks and HTTP serialization are real.
  const repository: MemoryRepository = {
    state: vi.fn(async () => state),
    snapshot: vi.fn(async () => ({
      ...state,
      memories: [
        {
          id: memoryId,
          version: 2,
          state: "current" as const,
          origin: "explicit" as const,
          kind: "preference" as const,
          sensitivity: "normal" as const,
          content: "Prefer blue",
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
          sources: [],
        },
      ],
    })),
    get: vi.fn(async () => []),
    changesForRequest: vi.fn(async () => null),
    getDeletionPreview: vi.fn(async () => null),
    deletionStatus: vi.fn(async () => null),
    write: unexpected,
    supersededSourceEventIds: unexpected,
    summary: unexpected,
    saveSummary: unexpected,
    previewDeletion: unexpected,
    confirmDeletion: unexpected,
    setCleanupStatus: unexpected,
  };
  const memory = new MemoryService({
    repository,
    ledger: new InMemoryConversationLedger(),
    epochManager: new ContextEpochManager({ generateId: randomUUID }),
  });
  // Exercise the real body-limit rejection without racing a large upload against connection closure.
  const app = Fastify({ logger: false, bodyLimit: 1_024 });
  registerMemoryRoutes(app, {
    authenticator: new DeviceAuthenticator({
      expectedHashHex: hashDeviceToken(deviceToken),
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    }),
    sealed: options.sealed ?? false,
    ...(options.unavailable ? {} : { memory }),
  });
  openApps.push(app);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  return { baseUrl, repository };
}

async function send(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string;
    authenticated?: boolean;
    requestId?: string | undefined;
  } = {},
) {
  const requestId = "requestId" in options ? options.requestId : randomUUID();
  const authenticated = options.authenticated ?? true;
  const contentType =
    options.contentType ?? (options.body !== undefined ? "application/json" : undefined);
  const method = options.method ?? "GET";
  const headers = {
    ...(authenticated ? { authorization: `Bearer ${deviceToken}` } : {}),
    ...(requestId ? { "x-request-id": requestId } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
  };
  console.info(
    JSON.stringify({
      event: "memory-http.send",
      method,
      path,
      requestId,
      authenticated,
      contentType,
      body:
        options.body && options.body.length > 2_000
          ? {
              bytes: Buffer.byteLength(options.body),
              sha256: createHash("sha256").update(options.body).digest("hex"),
            }
          : options.body,
    }),
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  const cacheControl = response.headers.get("cache-control");
  console.info(
    JSON.stringify({
      event: "memory-http.receive",
      method,
      path,
      requestId,
      status: response.status,
      cacheControl,
      body: text,
    }),
  );
  return { status: response.status, body: JSON.parse(text) as ApiError, cacheControl, requestId };
}

function assertError(
  response: Awaited<ReturnType<typeof send>>,
  status: number,
  code: string,
  retryable: boolean,
) {
  expect.soft(response.status).toBe(status);
  expect.soft(response.body).toMatchObject({ code, retryable });
  expect.soft(response.cacheControl).toBe("no-store");
  // The shared protocol validator resolves this error through error.schema.json.
  expect
    .soft(() =>
      assertChatStreamEvent({
        type: "error",
        eventId: randomUUID(),
        requestId: randomUUID(),
        error: response.body,
      }),
    )
    .not.toThrow();
  if (
    response.requestId &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(response.requestId)
  ) {
    expect.soft(response.body.requestId).toBe(response.requestId);
  }
  expect.soft(JSON.stringify(response.body)).not.toContain(privateMarker);
  expect.soft(JSON.stringify(response.body)).not.toContain(deviceToken);
}
