import type {
  AppendLedgerMessage,
  ConversationLedger,
  ConversationTurn,
  LedgerMessage,
  ListConversationTurns,
} from "@violet/domain";

export class InMemoryConversationLedger implements ConversationLedger {
  readonly #failedRequests = new Map<string, string>();
  readonly #messages: LedgerMessage[] = [];

  async append(input: AppendLedgerMessage): Promise<LedgerMessage> {
    assertContextReference(input);
    const existing = this.#messages.find(
      (message) => message.requestId === input.requestId && message.role === input.role,
    );
    if (existing) {
      return { ...existing, occurredAt: new Date(existing.occurredAt) };
    }

    const message: LedgerMessage = {
      content: input.content,
      ...(input.contextEpoch ? { contextEpochId: input.contextEpoch.id } : {}),
      ...(input.contextEventId ? { contextEventId: input.contextEventId } : {}),
      ...(input.contextSourceId ? { contextSourceId: input.contextSourceId } : {}),
      id: input.id,
      occurredAt: new Date(input.occurredAt),
      requestId: input.requestId,
      role: input.role,
      sequence: this.#messages.length + 1,
    };
    this.#messages.push(message);
    if (input.role === "assistant") {
      this.#failedRequests.delete(input.requestId);
    }
    return message;
  }

  async clearRequestFailure(requestId: string): Promise<boolean> {
    return this.#failedRequests.delete(requestId);
  }

  async findByRequest(
    requestId: string,
    role: "assistant" | "user",
  ): Promise<LedgerMessage | null> {
    const message = this.#messages.find(
      (candidate) => candidate.requestId === requestId && candidate.role === role,
    );
    return message ? { ...message, occurredAt: new Date(message.occurredAt) } : null;
  }

  async isCompletePrefix(
    contextEpochId: string,
    throughSequence: number,
    allowedIncompleteRequestIds: readonly string[] = [],
  ): Promise<boolean> {
    const messages = this.#messages.filter((message) => message.contextEpochId === contextEpochId);
    const allowedIncomplete = new Set(
      allowedIncompleteRequestIds.map((value) => value.toLowerCase()),
    );
    if (!messages.some((message) => message.sequence === throughSequence)) {
      return false;
    }
    const requestIds = new Set(
      messages
        .filter((message) => message.sequence <= throughSequence)
        .map((message) => message.requestId),
    );
    for (const requestId of requestIds) {
      if (allowedIncomplete.has(requestId.toLowerCase())) {
        continue;
      }
      const turn = messages.filter((message) => message.requestId === requestId);
      if (
        turn.some((message) => message.sequence > throughSequence) ||
        !turn.some((message) => message.role === "user") ||
        (!turn.some((message) => message.role === "assistant") &&
          this.#failedRequests.get(requestId) !== contextEpochId)
      ) {
        return false;
      }
    }
    return true;
  }

  async latestSequence(contextEpochId: string): Promise<number> {
    return this.#messages.reduce(
      (maximum, message) =>
        message.contextEpochId === contextEpochId ? Math.max(maximum, message.sequence) : maximum,
      0,
    );
  }

  async list(): Promise<readonly LedgerMessage[]> {
    return this.#messages.map((message) => ({
      ...message,
      occurredAt: new Date(message.occurredAt),
    }));
  }

  async listTurns(options: ListConversationTurns): Promise<readonly ConversationTurn[]> {
    return groupTurns(
      this.#messages.filter(
        (message) =>
          message.contextEpochId === options.contextEpochId &&
          (options.afterSequence === undefined || message.sequence > options.afterSequence) &&
          (options.beforeSequence === undefined || message.sequence < options.beforeSequence),
      ),
      options.completeOnly ?? false,
      new Set(
        [...this.#failedRequests]
          .filter(([, contextEpochId]) => contextEpochId === options.contextEpochId)
          .map(([requestId]) => requestId),
      ),
    );
  }

  async markRequestFailed(
    requestId: string,
    contextEpochId: string,
    _occurredAt: Date,
  ): Promise<void> {
    if (
      this.#messages.some(
        (message) => message.requestId === requestId && message.role === "assistant",
      )
    ) {
      this.#failedRequests.delete(requestId);
      return;
    }
    const user = this.#messages.find(
      (message) =>
        message.requestId === requestId &&
        message.role === "user" &&
        message.contextEpochId === contextEpochId,
    );
    if (!user) {
      throw new Error("Cannot fail a request without its persisted user event");
    }
    this.#failedRequests.set(requestId, contextEpochId);
  }

  async recoverIncompleteRequests(_occurredAt: Date): Promise<number> {
    let recovered = 0;
    for (const user of this.#messages.filter(
      (message) => message.role === "user" && message.contextEpochId,
    )) {
      if (
        this.#failedRequests.has(user.requestId) ||
        this.#messages.some(
          (message) => message.requestId === user.requestId && message.role === "assistant",
        )
      ) {
        continue;
      }
      this.#failedRequests.set(user.requestId, user.contextEpochId as string);
      recovered += 1;
    }
    return recovered;
  }
}

function assertContextReference(input: AppendLedgerMessage): void {
  const hasEvent = input.contextEventId !== undefined;
  const hasSource = input.contextSourceId !== undefined;
  if (hasEvent !== hasSource || (hasEvent && input.role !== "user")) {
    throw new Error("Context references require a user event ID and source ID");
  }
}

function groupTurns(
  messages: readonly LedgerMessage[],
  completeOnly: boolean,
  failedRequests: ReadonlySet<string>,
): readonly ConversationTurn[] {
  const grouped = new Map<string, LedgerMessage[]>();
  for (const message of messages) {
    const turn = grouped.get(message.requestId) ?? [];
    turn.push({ ...message, occurredAt: new Date(message.occurredAt) });
    grouped.set(message.requestId, turn);
  }

  return [...grouped.entries()]
    .map(([requestId, turnMessages]): ConversationTurn => {
      turnMessages.sort((left, right) => left.sequence - right.sequence);
      const completed =
        turnMessages.some((message) => message.role === "user") &&
        turnMessages.some((message) => message.role === "assistant");
      return {
        completed,
        failed: !completed && failedRequests.has(requestId),
        messages: turnMessages,
        requestId,
        startSequence: turnMessages[0]?.sequence ?? 0,
        throughSequence: turnMessages.at(-1)?.sequence ?? 0,
      };
    })
    .filter((turn) => !completeOnly || turn.completed)
    .sort((left, right) => left.startSequence - right.startSequence);
}
