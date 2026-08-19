import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { evaluateContentAccess } from "@violet/policy";
import {
  type ApiError,
  assertChatRequest,
  type ChatStreamEvent,
  type CoreStatus,
  type Health,
  ProtocolValidationError,
} from "@violet/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { DeviceAuthenticator } from "../auth/device-authenticator.js";
import type { ChatService } from "../conversation/chat-service.js";
import { recordHttpRequest } from "../telemetry-signals.js";

export interface CoreAppOptions {
  readonly authenticator: DeviceAuthenticator;
  readonly chatService: ChatService;
  readonly now?: () => Date;
  readonly sealed: boolean;
  readonly version: string;
}

export function buildCoreApp(options: CoreAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
  });
  const now = options.now ?? (() => new Date());

  app.addHook("onResponse", async (request, reply) => {
    recordHttpRequest({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
    });
  });

  app.get(
    "/v1/health/live",
    async (): Promise<Health> => ({
      service: "violet-core",
      status: "ok",
      time: now().toISOString(),
      version: options.version,
    }),
  );

  app.get("/v1/status", async (request, reply): Promise<CoreStatus | ApiError> => {
    if (!isAuthenticated(request, options.authenticator)) {
      return reply.code(401).send(
        apiError(request, {
          code: "UNAUTHENTICATED",
          message: "A valid device token is required",
          retryable: false,
        }),
      );
    }

    return {
      ...(options.sealed ? { reason: "content key is not loaded" } : {}),
      service: "violet-core",
      state: options.sealed ? "sealed" : "ready",
      time: now().toISOString(),
      version: options.version,
    };
  });

  app.post("/v1/chat/stream", async (request, reply) => {
    const access = evaluateContentAccess({
      authenticated: isAuthenticated(request, options.authenticator),
      sealed: options.sealed,
    });
    if (!access.allowed) {
      return reply.code(access.status).send(
        apiError(request, {
          code: access.code,
          message:
            access.code === "CORE_SEALED"
              ? "Violet Core is sealed"
              : "A valid device token is required",
          retryable: access.retryable,
        }),
      );
    }

    try {
      assertChatRequest(request.body);
    } catch (error) {
      if (error instanceof ProtocolValidationError) {
        return reply.code(400).send(
          apiError(request, {
            code: "INVALID_REQUEST",
            message: "Request does not conform to the Violet protocol",
            retryable: false,
          }),
        );
      }
      throw error;
    }

    const abortController = new AbortController();
    request.raw.once("aborted", () => abortController.abort());
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) {
        abortController.abort();
      }
    });
    const stream = Readable.from(
      serializeEvents(options.chatService.stream(request.body, abortController.signal)),
    );
    return reply.type("application/x-ndjson").send(stream);
  });

  return app;
}

function apiError(request: FastifyRequest, error: Omit<ApiError, "requestId">): ApiError {
  return {
    ...error,
    requestId: requestId(request),
  };
}

function isAuthenticated(request: FastifyRequest, authenticator: DeviceAuthenticator): boolean {
  return authenticator.authenticate(request.headers.authorization);
}

function requestId(request: FastifyRequest): string {
  const value = request.headers["x-request-id"];
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : randomUUID();
}

async function* serializeEvents(events: AsyncIterable<ChatStreamEvent>): AsyncIterable<string> {
  for await (const event of events) {
    yield `${JSON.stringify(event)}\n`;
  }
}
