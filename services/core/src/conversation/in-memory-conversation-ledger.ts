import type {
  AppendLedgerMessage,
  ConversationLedger,
  ConversationTurn,
  LedgerMessage,
  ListConversationTurns,
} from "@violet/domain";

export class InMemoryConversationLedger implements ConversationLedger {
  readonly #messages: LedgerMessage[] = [];

  async append(input: AppendLedgerMessage): Promise<LedgerMessage> {
    const existing = this.#messages.find(
      (message) => message.requestId === input.requestId && message.role === input.role,
    );
    if (existing) {
      return { ...existing, occurredAt: new Date(existing.occurredAt) };
    }

    const message: LedgerMessage = {
      content: input.content,
      ...(input.contextEpoch ? { contextEpochId: input.contextEpoch.id } : {}),
      id: input.id,
      occurredAt: new Date(input.occurredAt),
      requestId: input.requestId,
      role: input.role,
      sequence: this.#messages.length + 1,
    };
    this.#messages.push(message);
    return message;
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

  async isCompletePrefix(contextEpochId: string, throughSequence: number): Promise<boolean> {
    const messages = this.#messages.filter((message) => message.contextEpochId === contextEpochId);
    if (!messages.some((message) => message.sequence === throughSequence)) {
      return false;
    }
    const requestIds = new Set(
      messages
        .filter((message) => message.sequence <= throughSequence)
        .map((message) => message.requestId),
    );
    for (const requestId of requestIds) {
      const turn = messages.filter((message) => message.requestId === requestId);
      if (
        turn.some((message) => message.sequence > throughSequence) ||
        !turn.some((message) => message.role === "user") ||
        !turn.some((message) => message.role === "assistant")
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
    );
  }
}

function groupTurns(
  messages: readonly LedgerMessage[],
  completeOnly: boolean,
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
      return {
        completed:
          turnMessages.some((message) => message.role === "user") &&
          turnMessages.some((message) => message.role === "assistant"),
        messages: turnMessages,
        requestId,
        startSequence: turnMessages[0]?.sequence ?? 0,
        throughSequence: turnMessages.at(-1)?.sequence ?? 0,
      };
    })
    .filter((turn) => !completeOnly || turn.completed)
    .sort((left, right) => left.startSequence - right.startSequence);
}
