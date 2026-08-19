import type { AppendLedgerMessage, ConversationLedger, LedgerMessage } from "@violet/domain";

export class InMemoryConversationLedger implements ConversationLedger {
  readonly #messages: LedgerMessage[] = [];

  async append(input: AppendLedgerMessage): Promise<LedgerMessage> {
    const existing = this.#messages.find(
      (message) => message.requestId === input.requestId && message.role === input.role,
    );
    if (existing) {
      return existing;
    }

    const message: LedgerMessage = {
      ...input,
      occurredAt: new Date(input.occurredAt),
      sequence: this.#messages.length + 1,
    };
    this.#messages.push(message);
    return message;
  }

  async list(): Promise<readonly LedgerMessage[]> {
    return this.#messages.map((message) => ({
      ...message,
      occurredAt: new Date(message.occurredAt),
    }));
  }
}
