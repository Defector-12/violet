const maximumContextLifetimeMs = 5 * 60 * 1000;
const maximumClockSkewMs = 30 * 1000;

export type ContextAccessDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly code:
        | "CONTEXT_EXPIRED"
        | "CONTEXT_LIFETIME_EXCEEDED"
        | "CONTEXT_NOT_AUTHORIZED"
        | "CONTEXT_TIMESTAMP_INVALID";
      readonly status: 400 | 410;
    };

export function evaluateContextAccess(input: {
  readonly capturedAt: Date;
  readonly controlledSensitiveAllowed: boolean;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly sensitivity: "controlled" | "personal" | "public";
}): ContextAccessDecision {
  if (
    !Number.isFinite(input.capturedAt.valueOf()) ||
    !Number.isFinite(input.expiresAt.valueOf()) ||
    input.capturedAt.getTime() > input.now.getTime() + maximumClockSkewMs ||
    input.expiresAt <= input.capturedAt
  ) {
    return {
      allowed: false,
      code: "CONTEXT_TIMESTAMP_INVALID",
      status: 400,
    };
  }

  if (input.expiresAt.getTime() - input.capturedAt.getTime() > maximumContextLifetimeMs) {
    return {
      allowed: false,
      code: "CONTEXT_LIFETIME_EXCEEDED",
      status: 400,
    };
  }

  if (input.expiresAt <= input.now) {
    return {
      allowed: false,
      code: "CONTEXT_EXPIRED",
      status: 410,
    };
  }

  if (input.sensitivity === "controlled" && !input.controlledSensitiveAllowed) {
    return {
      allowed: false,
      code: "CONTEXT_NOT_AUTHORIZED",
      status: 400,
    };
  }

  return { allowed: true };
}
