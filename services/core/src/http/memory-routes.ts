import { createHash } from "node:crypto";
import { MemoryConflictError, MemorySourceError } from "@violet/domain";
import { evaluateContentAccess, MemorySecretError } from "@violet/policy";
import {
  assertMemoryCorrection,
  assertMemoryDeletionConfirmation,
  assertMemoryDeletionPreviewRequest,
  assertMemorySettingsUpdate,
  ProtocolValidationError,
} from "@violet/protocol";
import { errorCodes, type FastifyInstance, type FastifyRequest } from "fastify";
import type { DeviceAuthenticator } from "../auth/device-authenticator.js";
import { MemoryNotFoundError, type MemoryService } from "../memory/memory-service.js";
import { apiError } from "./api-error.js";

export function registerMemoryRoutes(
  app: FastifyInstance,
  options: {
    readonly authenticator: DeviceAuthenticator;
    readonly sealed: boolean;
    readonly memory?: MemoryService;
  },
): void {
  app.register(async (routes) => {
    routes.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });
    routes.addHook("preHandler", async (request, reply) => {
      const access = evaluateContentAccess({
        authenticated: options.authenticator.authenticate(request.headers.authorization),
        sealed: options.sealed,
      });
      if (!access.allowed) {
        return reply.code(access.status).send(
          apiError(request, {
            code: access.code,
            message: "Memory access is unavailable",
            retryable: access.retryable,
          }),
        );
      }
      if (!options.memory) {
        return reply.code(503).send(
          apiError(request, {
            code: "MEMORY_UNAVAILABLE",
            message: "Persistent memory is unavailable",
            retryable: true,
          }),
        );
      }
    });
    routes.setErrorHandler((error, request, reply) => {
      const parsingStatus =
        error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE
          ? 413
          : error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE
            ? 415
            : error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
                error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
                error instanceof errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH
              ? 400
              : undefined;
      if (parsingStatus !== undefined) {
        return reply.code(parsingStatus).send(
          apiError(request, {
            code: "INVALID_MEMORY_REQUEST",
            message: "Memory request body is invalid or unsupported",
            retryable: false,
          }),
        );
      }
      const invalid =
        error instanceof ProtocolValidationError ||
        error instanceof MemorySecretError ||
        error instanceof MemorySourceError;
      const status = invalid
        ? 400
        : error instanceof MemoryConflictError
          ? 409
          : error instanceof MemoryNotFoundError
            ? 404
            : 500;
      return reply.code(status).send(
        apiError(request, {
          code:
            error instanceof MemorySecretError
              ? "MEMORY_SECRET_REJECTED"
              : status === 400
                ? "INVALID_MEMORY_REQUEST"
                : status === 409
                  ? "MEMORY_CONFLICT"
                  : status === 404
                    ? "MEMORY_NOT_FOUND"
                    : "MEMORY_UNAVAILABLE",
          message:
            status === 500 || !(error instanceof Error) ? "Memory operation failed" : error.message,
          retryable: status === 500 || status === 409,
        }),
      );
    });
    routes.get("/v1/memories", async () => options.memory?.list());
    routes.get("/v1/memory-settings", async () => options.memory?.repository.settings());
    routes.post("/v1/memory-settings", async (request) => {
      assertMemorySettingsUpdate(request.body);
      return options.memory?.repository.updateSettings(request.body);
    });
    routes.get("/v1/memories/:memoryId", async (request) => {
      const query = request.query as { reveal?: string };
      return options.memory?.detail(pathId(request, "memoryId"), query.reveal === "true");
    });
    routes.post("/v1/memories/:memoryId/corrections", async (request) => {
      assertMemoryCorrection(request.body);
      const memoryChanges = await options.memory?.correct(
        pathId(request, "memoryId"),
        request.body,
      );
      return { memoryChanges };
    });
    routes.post("/v1/memory-deletions/previews", async (request) => {
      assertMemoryDeletionPreviewRequest(request.body);
      return options.memory?.preview(request.body);
    });
    routes.get("/v1/memory-deletions/:deletionId/preview", async (request) =>
      options.memory?.getPreview(pathId(request, "deletionId")),
    );
    routes.post("/v1/memory-deletions/:deletionId/confirm", async (request) => {
      assertMemoryDeletionConfirmation(request.body);
      // The existing single-device authenticator exposes no device row. Persist its
      // nonreversible identity, never the token, in the nonsemantic deletion audit.
      const deviceId = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest("hex");
      return options.memory?.confirm(pathId(request, "deletionId"), request.body, deviceId);
    });
    routes.get("/v1/memory-deletions/:deletionId", async (request) =>
      options.memory?.deletionStatus(pathId(request, "deletionId")),
    );
    routes.post("/v1/memory-deletions/:deletionId/retry", async (request) =>
      options.memory?.retryCleanup(pathId(request, "deletionId")),
    );
  });
}

function pathId(request: FastifyRequest, key: string): string {
  const value = (request.params as Record<string, string>)[key];
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new MemorySourceError("Memory ID is invalid");
  }
  return value.toLowerCase();
}
