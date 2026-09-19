export type ConversationRole = "assistant" | "user";

export interface ContextEpoch {
  readonly id: string;
  readonly startedAt: Date;
}

export interface LedgerMessage {
  readonly content: string;
  readonly contextEpochId?: string;
  readonly contextEventId?: string;
  readonly contextSourceId?: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
  readonly sequence: number;
}

export interface AppendLedgerMessage {
  readonly content: string;
  readonly contextEpoch?: ContextEpoch;
  readonly contextEventId?: string;
  readonly contextSourceId?: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
}

export interface ConversationTurn {
  readonly completed: boolean;
  readonly failed: boolean;
  readonly messages: readonly LedgerMessage[];
  readonly requestId: string;
  readonly startSequence: number;
  readonly throughSequence: number;
}

export interface ListConversationTurns {
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly completeOnly?: boolean;
  readonly contextEpochId: string;
}

export interface ConversationLedger {
  append(message: AppendLedgerMessage): Promise<LedgerMessage>;
  clearRequestFailure(requestId: string): Promise<boolean>;
  findByRequest(requestId: string, role: ConversationRole): Promise<LedgerMessage | null>;
  isCompletePrefix(
    contextEpochId: string,
    throughSequence: number,
    allowedIncompleteRequestIds?: readonly string[],
  ): Promise<boolean>;
  latestSequence(contextEpochId: string): Promise<number>;
  list(): Promise<readonly LedgerMessage[]>;
  listTurns(options: ListConversationTurns): Promise<readonly ConversationTurn[]>;
  markRequestFailed(requestId: string, contextEpochId: string, occurredAt: Date): Promise<void>;
  recoverIncompleteRequests(occurredAt: Date): Promise<number>;
}

export function assertContextReference(input: AppendLedgerMessage): void {
  const hasEvent = input.contextEventId !== undefined;
  const hasSource = input.contextSourceId !== undefined;
  if (hasEvent !== hasSource || (hasEvent && input.role !== "user")) {
    throw new Error("Context references require a user event ID and source ID");
  }
}

// Storage adapters supply messages in sequence order.
export function groupConversationTurns(
  messages: readonly LedgerMessage[],
  completeOnly: boolean,
  failedRequests: ReadonlySet<string>,
): readonly ConversationTurn[] {
  const grouped = new Map<string, LedgerMessage[]>();
  for (const message of messages) {
    const turn = grouped.get(message.requestId) ?? [];
    turn.push(message);
    grouped.set(message.requestId, turn);
  }

  return [...grouped.entries()]
    .map(([requestId, turnMessages]): ConversationTurn => {
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
    .filter((turn) => !completeOnly || turn.completed);
}
