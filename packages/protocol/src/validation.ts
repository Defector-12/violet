import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import chatRequestSchema from "../schemas/v1/chat-request.schema.json" with { type: "json" };
import chatStreamEventSchema from "../schemas/v1/chat-stream-event.schema.json" with {
  type: "json",
};
import errorSchema from "../schemas/v1/error.schema.json" with { type: "json" };
import healthSchema from "../schemas/v1/health.schema.json" with { type: "json" };
import realtimeClientEventSchema from "../schemas/v1/realtime-client-event.schema.json" with {
  type: "json",
};
import realtimeServerEventSchema from "../schemas/v1/realtime-server-event.schema.json" with {
  type: "json",
};
import statusSchema from "../schemas/v1/status.schema.json" with { type: "json" };
import type {
  ChatRequest,
  ChatStreamEvent,
  CoreStatus,
  Health,
  RealtimeClientEvent,
  RealtimeServerEvent,
} from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

(addFormats as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
ajv.addSchema(errorSchema);

const chatRequestValidator = ajv.compile<ChatRequest>(chatRequestSchema);
const chatStreamEventValidator = ajv.compile<ChatStreamEvent>(chatStreamEventSchema);
const coreStatusValidator = ajv.compile<CoreStatus>(statusSchema);
const healthValidator = ajv.compile<Health>(healthSchema);
const realtimeClientEventValidator = ajv.compile<RealtimeClientEvent>(realtimeClientEventSchema);
const realtimeServerEventValidator = ajv.compile<RealtimeServerEvent>(realtimeServerEventSchema);

export class ProtocolValidationError extends Error {
  readonly validationErrors: readonly ErrorObject[];

  constructor(schemaName: string, errors: readonly ErrorObject[]) {
    super(`Value does not conform to ${schemaName}`);
    this.name = "ProtocolValidationError";
    this.validationErrors = errors;
  }
}

function assertValid<T>(
  schemaName: string,
  validator: ValidateFunction<T>,
  value: unknown,
): asserts value is T {
  if (!validator(value)) {
    throw new ProtocolValidationError(schemaName, validator.errors ?? []);
  }
}

export function assertChatRequest(value: unknown): asserts value is ChatRequest {
  assertValid("ChatRequest", chatRequestValidator, value);
}

export function assertChatStreamEvent(value: unknown): asserts value is ChatStreamEvent {
  assertValid("ChatStreamEvent", chatStreamEventValidator, value);
}

export function assertCoreStatus(value: unknown): asserts value is CoreStatus {
  assertValid("CoreStatus", coreStatusValidator, value);
}

export function assertHealth(value: unknown): asserts value is Health {
  assertValid("Health", healthValidator, value);
}

export function assertRealtimeClientEvent(value: unknown): asserts value is RealtimeClientEvent {
  assertValid("RealtimeClientEvent", realtimeClientEventValidator, value);
}

export function assertRealtimeServerEvent(value: unknown): asserts value is RealtimeServerEvent {
  assertValid("RealtimeServerEvent", realtimeServerEventValidator, value);
}
