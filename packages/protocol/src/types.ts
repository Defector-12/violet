import type { components } from "./generated/api.js";

export type ApiError = components["schemas"]["error.schema"];
export type ChatRequest = components["schemas"]["chat-request.schema"];
export type ChatStreamEvent = components["schemas"]["ChatStreamEvent"];
export type CoreStatus = components["schemas"]["status.schema"];
export type Health = components["schemas"]["health.schema"];
