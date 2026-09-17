export type ConversationRole = "assistant" | "user";

export interface ContextEpoch {
  readonly id: string;
  readonly startedAt: Date;
}

export interface LedgerMessage {
  readonly content: string;
  readonly contextEpochId?: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
  readonly sequence: number;
}

export interface AppendLedgerMessage {
  readonly content: string;
  readonly contextEpoch?: ContextEpoch;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
}

export interface ConversationTurn {
  readonly completed: boolean;
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
  findByRequest(requestId: string, role: ConversationRole): Promise<LedgerMessage | null>;
  list(): Promise<readonly LedgerMessage[]>;
  listTurns(options: ListConversationTurns): Promise<readonly ConversationTurn[]>;
}
