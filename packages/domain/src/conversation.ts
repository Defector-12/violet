export type ConversationRole = "assistant" | "user";

export interface ConversationMessage {
  readonly content: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
  readonly sequence: number;
}

export interface NewConversationMessage {
  readonly content: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
}

export class Conversation {
  readonly #id: string;
  readonly #identityId: string;
  readonly #messages: ConversationMessage[];

  constructor(input: {
    readonly id: string;
    readonly identityId: string;
    readonly messages?: readonly ConversationMessage[];
  }) {
    if (input.id.trim().length === 0 || input.identityId.trim().length === 0) {
      throw new Error("conversation and identity ids must not be empty");
    }

    this.#id = input.id;
    this.#identityId = input.identityId;
    this.#messages = [...(input.messages ?? [])].sort((left, right) => {
      return left.sequence - right.sequence;
    });
    this.#assertSequence();
  }

  get id(): string {
    return this.#id;
  }

  get identityId(): string {
    return this.#identityId;
  }

  get messages(): readonly ConversationMessage[] {
    return this.#messages.map((message) => ({
      ...message,
      occurredAt: new Date(message.occurredAt),
    }));
  }

  append(input: NewConversationMessage): ConversationMessage {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("message content must not be empty");
    }

    const message: ConversationMessage = Object.freeze({
      content,
      id: input.id,
      occurredAt: new Date(input.occurredAt),
      requestId: input.requestId,
      role: input.role,
      sequence: this.#messages.length + 1,
    });
    this.#messages.push(message);
    return message;
  }

  #assertSequence(): void {
    for (const [index, message] of this.#messages.entries()) {
      if (message.sequence !== index + 1) {
        throw new Error("conversation messages must have a contiguous sequence");
      }
    }
  }
}
