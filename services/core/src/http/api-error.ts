import { randomUUID } from "node:crypto";
import type { ApiError } from "@violet/protocol";
import type { FastifyRequest } from "fastify";

export function apiError(request: FastifyRequest, error: Omit<ApiError, "requestId">): ApiError {
  return {
    ...error,
    requestId: requestId(request),
  };
}

export function requestId(request: FastifyRequest): string {
  const value = request.headers["x-request-id"];
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : randomUUID();
}
