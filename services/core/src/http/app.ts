import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import websocket from "@fastify/websocket";
import type { ConversationLedger, RealtimeConversationPort } from "@violet/domain";
import { evaluateContentAccess } from "@violet/policy";
import {
  type ApiError,
  assertChatRequest,
  assertContextEnvelope,
  type ChatStreamEvent,
  type ContextReceipt,
  type CoreStatus,
  type Health,
  ProtocolValidationError,
} from "@violet/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { DeviceAuthenticator } from "../auth/device-authenticator.js";
import { type ContextService, ContextServiceError } from "../context/context-service.js";
import type { ChatService } from "../conversation/chat-service.js";
import type { ConversationEndIntentPort } from "../realtime/conversation-end-intent.js";
import { handleRealtimeWebSocket } from "../realtime/realtime-websocket.js";
import { recordHttpRequest } from "../telemetry-signals.js";

export interface CoreAppOptions {
  readonly authenticator: DeviceAuthenticator;
  readonly chatService: ChatService;
  readonly conversationEndIntent: ConversationEndIntentPort;
  readonly contextService: ContextService;
  readonly now?: () => Date;
  readonly realtimeConversationPort: RealtimeConversationPort;
  readonly realtimeLedger: ConversationLedger;
  readonly sealed: boolean;
  readonly version: string;
}

export function buildCoreApp(options: CoreAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
  });
  app.register(websocket, {
    options: {
      maxPayload: 150000,
    },
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

  app.post(
    "/v1/context/envelopes",
    {
      bodyLimit: 12 * 1024 * 1024,
    },
    async (request, reply): Promise<ContextReceipt | ApiError> => {
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
        assertContextEnvelope(request.body);
        return await options.contextService.submit(request.body);
      } catch (error) {
        if (error instanceof ProtocolValidationError) {
          return reply.code(400).send(
            apiError(request, {
              code: "INVALID_CONTEXT_ENVELOPE",
              message: "Context does not conform to the Violet protocol",
              retryable: false,
            }),
          );
        }
        if (error instanceof ContextServiceError) {
          return reply.code(error.status).send(
            apiError(request, {
              code: error.code,
              message: "Context was rejected by Violet policy",
              retryable: false,
            }),
          );
        }
        throw error;
      }
    },
  );

  app.delete("/v1/context/sessions/:sessionId", async (request, reply) => {
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

    const { sessionId } = request.params as { readonly sessionId: string };
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
    ) {
      return reply.code(400).send(
        apiError(request, {
          code: "INVALID_CONTEXT_SESSION",
          message: "Context session ID is invalid",
          retryable: false,
        }),
      );
    }
    await options.contextService.delete(sessionId);
    return reply.code(204).send();
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
    let contextEvidence: string | undefined;
    if (request.body.contextSessionId) {
      try {
        contextEvidence = (await options.contextService.get(request.body.contextSessionId)).summary;
      } catch (error) {
        if (error instanceof ContextServiceError) {
          return reply.code(error.status).send(
            apiError(request, {
              code: error.code,
              message: "The requested context is unavailable",
              retryable: false,
            }),
          );
        }
        throw error;
      }
    }
    const stream = Readable.from(
      serializeEvents(
        options.chatService.stream(request.body, abortController.signal, contextEvidence),
      ),
    );
    return reply.type("application/x-ndjson").send(stream);
  });

  app.register(async (realtimeRoutes) => {
    realtimeRoutes.get(
      "/v1/realtime",
      {
        preValidation: async (request, reply) => {
          const access = evaluateContentAccess({
            authenticated: isAuthenticated(request, options.authenticator),
            sealed: options.sealed,
          });
          if (!access.allowed) {
            await reply.code(access.status).send(
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
        },
        websocket: true,
      },
      (socket) => {
        handleRealtimeWebSocket(socket, {
          conversationEndIntent: options.conversationEndIntent,
          conversationPort: options.realtimeConversationPort,
          contextService: options.contextService,
          generateId: randomUUID,
          ledger: options.realtimeLedger,
        });
      },
    );
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
