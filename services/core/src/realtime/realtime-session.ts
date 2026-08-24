import type {
  ConversationLedger,
  RealtimeConversation,
  RealtimeConversationInput,
  RealtimeConversationOutput,
  RealtimeConversationPort,
  RealtimeSessionConfiguration,
} from "@violet/domain";
import type { RealtimeClientEvent, RealtimeServerEvent } from "@violet/protocol";

export interface RealtimeSessionOptions {
  readonly conversationPort: RealtimeConversationPort;
  readonly generateId: () => string;
  readonly ledger: ConversationLedger;
  readonly now?: () => Date;
}

export class RealtimeSession {
  readonly #conversationPort: RealtimeConversationPort;
  readonly #generateId: () => string;
  readonly #ledger: ConversationLedger;
  readonly #now: () => Date;
  readonly #assistantContent = new Map<string, string>();
  readonly #clientEventIds = new Set<string>();
  readonly #persistedTurns = new Set<string>();
  #closed = false;
  #conversation: RealtimeConversation | null = null;
  #expectedClientSequence = 1;
  #serverSequence = 1;
  #sessionId: string | null = null;

  constructor(options: RealtimeSessionOptions) {
    this.#conversationPort = options.conversationPort;
    this.#generateId = options.generateId;
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date());
  }

  get closed(): boolean {
    return this.#closed;
  }

  get configured(): boolean {
    return this.#conversation !== null;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#conversation?.close();
    this.#assistantContent.clear();
    this.#clientEventIds.clear();
    this.#persistedTurns.clear();
  }

  async *handle(
    event: RealtimeClientEvent,
    signal?: AbortSignal,
  ): AsyncIterable<RealtimeServerEvent> {
    if (this.#closed) {
      yield this.#error(event.sessionId, "SESSION_CLOSED", "The realtime session is closed");
      return;
    }
    if (event.sequence !== this.#expectedClientSequence) {
      yield this.#error(
        event.sessionId,
        "INVALID_EVENT_SEQUENCE",
        `Expected client sequence ${this.#expectedClientSequence}`,
      );
      return;
    }
    if (this.#sessionId && event.sessionId !== this.#sessionId) {
      yield this.#error(
        event.sessionId,
        "SESSION_ID_MISMATCH",
        "The event does not belong to this realtime session",
      );
      return;
    }
    if (this.#clientEventIds.has(event.eventId)) {
      yield this.#error(
        event.sessionId,
        "DUPLICATE_EVENT",
        "The realtime event has already been processed",
      );
      return;
    }

    this.#sessionId ??= event.sessionId;
    this.#clientEventIds.add(event.eventId);
    this.#expectedClientSequence += 1;

    if (event.type === "session.configure") {
      if (this.#conversation) {
        yield this.#error(
          event.sessionId,
          "SESSION_ALREADY_CONFIGURED",
          "The realtime session is already configured",
        );
        return;
      }

      const history = (await this.#ledger.list())
        .slice(-40)
        .map(({ content, role }) => ({ content, role }));
      this.#conversation = await this.#conversationPort.open(
        {
          ...mapConfiguration(event.configuration),
          history,
        },
        signal,
      );
      yield {
        capabilities: {
          ...(this.#conversation.capabilities.inputAudio
            ? { inputAudio: this.#conversation.capabilities.inputAudio }
            : {}),
          inputModalities: [...this.#conversation.capabilities.inputModalities],
          interruption: this.#conversation.capabilities.interruption,
          ...(this.#conversation.capabilities.outputAudio
            ? { outputAudio: this.#conversation.capabilities.outputAudio }
            : {}),
          outputModalities: [...this.#conversation.capabilities.outputModalities],
          runtimeKind: this.#conversation.capabilities.runtimeKind,
          transcription: this.#conversation.capabilities.transcription,
          turnDetection: this.#conversation.capabilities.turnDetection,
          voiceKind: this.#conversation.capabilities.voiceKind,
        },
        ...this.#baseEvent(event.sessionId),
        type: "session.ready",
      };
      return;
    }

    if (!this.#conversation) {
      yield this.#error(
        event.sessionId,
        "SESSION_NOT_CONFIGURED",
        "Configure the realtime session before sending input",
      );
      return;
    }

    if (event.type === "session.close") {
      await this.close();
      return;
    }

    if (event.type === "input.text") {
      await this.#persistUserTurn(event.turnId, event.text);
    }

    try {
      await this.#conversation.send(mapInput(event), signal);
    } catch {
      yield this.#error(
        event.sessionId,
        "REALTIME_INPUT_FAILED",
        "The realtime runtime rejected the input",
      );
    }
  }

  async *outputs(signal?: AbortSignal): AsyncIterable<RealtimeServerEvent> {
    const conversation = this.#conversation;
    if (!conversation) {
      return;
    }
    for await (const output of conversation.outputs(signal)) {
      await this.#persistOutput(output);
      if (!this.#sessionId) {
        return;
      }
      yield this.#mapOutput(this.#sessionId, output);
    }
  }

  async #persistOutput(output: RealtimeConversationOutput): Promise<void> {
    switch (output.type) {
      case "speech-started":
      case "speech-stopped":
        break;
      case "transcript":
        if (output.final) {
          await this.#persistUserTurn(output.turnId, output.text);
        }
        break;
      case "response-started":
        this.#assistantContent.set(output.responseId, "");
        break;
      case "response-text":
        this.#assistantContent.set(
          output.responseId,
          (this.#assistantContent.get(output.responseId) ?? "") + output.text,
        );
        break;
      case "response-completed": {
        const content = this.#assistantContent.get(output.responseId);
        this.#assistantContent.delete(output.responseId);
        if (content) {
          await this.#ledger.append({
            content,
            id: this.#generateId(),
            occurredAt: this.#now(),
            requestId: output.turnId,
            role: "assistant",
          });
        }
        break;
      }
      case "response-cancelled":
        this.#assistantContent.delete(output.responseId);
        break;
      case "error":
      case "response-audio":
        break;
    }
  }

  async #persistUserTurn(turnId: string, content: string): Promise<void> {
    if (this.#persistedTurns.has(turnId)) {
      return;
    }
    await this.#ledger.append({
      content,
      id: this.#generateId(),
      occurredAt: this.#now(),
      requestId: turnId,
      role: "user",
    });
    this.#persistedTurns.add(turnId);
  }

  #baseEvent(sessionId: string): {
    readonly eventId: string;
    readonly sequence: number;
    readonly sessionId: string;
  } {
    return {
      eventId: this.#generateId(),
      sequence: this.#serverSequence++,
      sessionId,
    };
  }

  #error(sessionId: string, code: string, message: string): RealtimeServerEvent {
    return {
      code,
      message,
      retryable: false,
      ...this.#baseEvent(sessionId),
      type: "error",
    };
  }

  #mapOutput(sessionId: string, output: RealtimeConversationOutput): RealtimeServerEvent {
    const base = this.#baseEvent(sessionId);
    switch (output.type) {
      case "speech-started":
        return {
          turnId: output.turnId,
          ...base,
          type: "input.speech.started",
        };
      case "speech-stopped":
        return {
          turnId: output.turnId,
          ...base,
          type: "input.speech.stopped",
        };
      case "transcript":
        return {
          final: output.final,
          text: output.text,
          turnId: output.turnId,
          ...base,
          type: "input.transcript",
        };
      case "response-started":
        return {
          responseId: output.responseId,
          turnId: output.turnId,
          ...base,
          type: "response.started",
        };
      case "response-text":
        return {
          responseId: output.responseId,
          text: output.text,
          turnId: output.turnId,
          ...base,
          type: "response.text",
        };
      case "response-audio":
        return {
          audio: Buffer.from(output.audio).toString("base64"),
          responseId: output.responseId,
          turnId: output.turnId,
          ...base,
          type: "response.audio",
        };
      case "response-completed":
        return {
          responseId: output.responseId,
          turnId: output.turnId,
          usage: {
            inputTokens: output.inputTokens,
            outputTokens: output.outputTokens,
          },
          ...base,
          type: "response.completed",
        };
      case "response-cancelled":
        return {
          responseId: output.responseId,
          ...base,
          type: "response.cancelled",
        };
      case "error":
        return {
          code: output.code,
          message: output.message,
          retryable: output.retryable,
          ...base,
          type: "error",
        };
    }
  }
}

function mapConfiguration(
  configuration: Extract<
    RealtimeClientEvent,
    { readonly type: "session.configure" }
  >["configuration"],
): RealtimeSessionConfiguration {
  return {
    ...(configuration.inputAudio ? { inputAudio: configuration.inputAudio } : {}),
    inputModalities: configuration.inputModalities,
    ...(configuration.language ? { language: configuration.language } : {}),
    ...(configuration.outputAudio ? { outputAudio: configuration.outputAudio } : {}),
    outputModalities: configuration.outputModalities,
    ...(configuration.turnDetection
      ? { turnDetection: configuration.turnDetection }
      : { turnDetection: "manual" as const }),
    ...(configuration.voice ? { voice: configuration.voice } : {}),
  };
}

function mapInput(
  event: Exclude<RealtimeClientEvent, { readonly type: "session.close" | "session.configure" }>,
): RealtimeConversationInput {
  switch (event.type) {
    case "input.text":
      return {
        text: event.text,
        turnId: event.turnId,
        type: "text",
      };
    case "input.audio":
      return {
        audio: Buffer.from(event.audio, "base64"),
        turnId: event.turnId,
        type: "audio",
      };
    case "input.commit":
      return {
        turnId: event.turnId,
        type: "commit",
      };
    case "response.cancel":
      return {
        responseId: event.responseId,
        type: "cancel",
      };
  }
}
