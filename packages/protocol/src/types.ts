import type { components } from "./generated/api.js";

type WithoutSchemaDefinitions<T> = T extends unknown ? Omit<T, "$defs"> : never;

export type ApiError = components["schemas"]["error.schema"];
export type ChatRequest = components["schemas"]["chat-request.schema"];
export type ChatStreamEvent = components["schemas"]["ChatStreamEvent"];
export type ContextEnvelope = WithoutSchemaDefinitions<components["schemas"]["ContextEnvelope"]>;
export type ContextReceipt = components["schemas"]["ContextReceipt"];
export type CoreStatus = components["schemas"]["status.schema"];
export type Health = components["schemas"]["health.schema"];
type RawRealtimeClientEvent = WithoutSchemaDefinitions<
  components["schemas"]["RealtimeClientEvent"]
>;
export type RealtimeClientEvent = RawRealtimeClientEvent extends infer Event
  ? Event extends { readonly context: infer Context }
    ? Omit<Event, "context"> & { readonly context: WithoutSchemaDefinitions<Context> }
    : Event
  : never;
export type RealtimeServerEvent = WithoutSchemaDefinitions<
  components["schemas"]["RealtimeServerEvent"]
>;
export type Memory = components["schemas"]["Memory"];
export type MemorySettings = components["schemas"]["MemorySettings"];
export type MemorySettingsUpdate = components["schemas"]["MemorySettingsUpdate"];
export type MemoryChange = components["schemas"]["MemoryChange"];
export type MemoryList = components["schemas"]["MemoryList"];
export type MemoryDetail = components["schemas"]["MemoryDetail"];
export type MemoryCorrection = components["schemas"]["MemoryCorrection"];
export type MemoryMutation = components["schemas"]["MemoryMutation"];
export type MemoryDeletionPreviewRequest = components["schemas"]["MemoryDeletionPreviewRequest"];
export type MemoryDeletionPreview = components["schemas"]["MemoryDeletionPreview"];
export type MemoryDeletionConfirmation = components["schemas"]["MemoryDeletionConfirmation"];
export type MemoryDeletionStatus = components["schemas"]["MemoryDeletionStatus"];
