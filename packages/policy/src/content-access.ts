export type ContentAccessDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly code: "CORE_SEALED" | "UNAUTHENTICATED";
      readonly retryable: boolean;
      readonly status: 401 | 423;
    };

export function evaluateContentAccess(input: {
  readonly authenticated: boolean;
  readonly sealed: boolean;
}): ContentAccessDecision {
  if (!input.authenticated) {
    return {
      allowed: false,
      code: "UNAUTHENTICATED",
      retryable: false,
      status: 401,
    };
  }

  if (input.sealed) {
    return {
      allowed: false,
      code: "CORE_SEALED",
      retryable: true,
      status: 423,
    };
  }

  return { allowed: true };
}
