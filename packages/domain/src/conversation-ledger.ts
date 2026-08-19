import type { ConversationRole } from "./conversation.js";

export interface LedgerMessage {
  readonly content: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
  readonly sequence: number;
}

export interface AppendLedgerMessage {
  readonly content: string;
  readonly id: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly role: ConversationRole;
}

export interface ConversationLedger {
  append(message: AppendLedgerMessage): Promise<LedgerMessage>;
  list(): Promise<readonly LedgerMessage[]>;
}
