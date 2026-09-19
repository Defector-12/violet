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
