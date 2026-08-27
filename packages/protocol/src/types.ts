import type { components } from "./generated/api.js";

type WithoutSchemaDefinitions<T> = T extends unknown ? Omit<T, "$defs"> : never;

export type ApiError = components["schemas"]["error.schema"];
export type ChatRequest = components["schemas"]["chat-request.schema"];
export type ChatStreamEvent = components["schemas"]["ChatStreamEvent"];
export type ContextEnvelope = WithoutSchemaDefinitions<components["schemas"]["ContextEnvelope"]>;
export type ContextReceipt = components["schemas"]["ContextReceipt"];
export type CoreStatus = components["schemas"]["status.schema"];
export type Health = components["schemas"]["health.schema"];
export type RealtimeClientEvent = WithoutSchemaDefinitions<
  components["schemas"]["RealtimeClientEvent"]
>;
export type RealtimeServerEvent = WithoutSchemaDefinitions<
  components["schemas"]["RealtimeServerEvent"]
>;
