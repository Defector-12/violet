import type {
  ConversationLedger,
  RealtimeConversation,
  RealtimeConversationInput,
  RealtimeConversationOutput,
  RealtimeConversationPort,
  RealtimeSessionConfiguration,
} from "@violet/domain";
import type { RealtimeClientEvent, RealtimeServerEvent } from "@violet/protocol";

import { type ContextService, ContextServiceError } from "../context/context-service.js";
import type { ConversationEndIntentPort } from "./conversation-end-intent.js";
import { recordTestTrace, withTestTraceIds } from "./test-trace.js";
import { formatVisualResult } from "./visual-grounding.js";

const maximumCaptureClockSkewMs = 30_000;

function canonicalId(value: string): string {
  return value.toLowerCase();
}

interface PendingContextCapture {
  readonly abortController: AbortController;
  readonly callId: string;
  readonly conversation: RealtimeConversation;
  readonly expiresAt: Date;
  readonly query: string;
  readonly requestId: string;
  readonly requestedAt: Date;
  readonly timeout: NodeJS.Timeout;
  readonly turnId: string;
}

export interface RealtimeSessionOptions {
  readonly conversationEndIntent: ConversationEndIntentPort;
  readonly conversationPort: RealtimeConversationPort;
  readonly contextService: ContextService;
  readonly endIntentWaitMs?: number;
  readonly generateId: () => string;
  readonly ledger: ConversationLedger;
  readonly now?: () => Date;
}

export class RealtimeSession {
  readonly #conversationEndIntent: ConversationEndIntentPort;
  readonly #conversationPort: RealtimeConversationPort;
  readonly #contextService: ContextService;
  readonly #endIntentWaitMs: number;
  readonly #generateId: () => string;
  readonly #ledger: ConversationLedger;
  readonly #now: () => Date;
  readonly #assistantContent = new Map<string, string>();
  readonly #clientEventIds = new Set<string>();
  readonly #deferredResponseOutputs = new Map<string, RealtimeConversationOutput[]>();
  readonly #endIntentByTurn = new Map<
    string,
    { readonly abortController: AbortController; readonly result: Promise<boolean> }
  >();
  readonly #finalTranscripts = new Map<string, string>();
  readonly #pendingContextCaptures = new Map<string, PendingContextCapture>();
  readonly #persistedTurns = new Set<string>();
  readonly #responseTurnIds = new Map<string, string>();
  readonly #visibleResponseIds = new Set<string>();
  readonly #visualRequestedTurns = new Set<string>();
  #closed = false;
  #activeTurnId: string | null = null;
  #conversation: RealtimeConversation | null = null;
  #contextSessionId: string | null = null;
  #onDemandContext = false;
  #expectedClientSequence = 1;
  #serverSequence = 1;
  #sessionId: string | null = null;

  constructor(options: RealtimeSessionOptions) {
    this.#conversationEndIntent = options.conversationEndIntent;
    this.#conversationPort = options.conversationPort;
    this.#contextService = options.contextService;
    this.#endIntentWaitMs = options.endIntentWaitMs ?? 1_000;
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
    this.#assistantContent.clear();
    this.#clientEventIds.clear();
    this.#deferredResponseOutputs.clear();
    for (const pending of this.#endIntentByTurn.values()) {
      pending.abortController.abort();
    }
    this.#endIntentByTurn.clear();
    this.#finalTranscripts.clear();
    for (const pending of this.#pendingContextCaptures.values()) {
      clearTimeout(pending.timeout);
      pending.abortController.abort();
    }
    this.#pendingContextCaptures.clear();
    this.#persistedTurns.clear();
    this.#responseTurnIds.clear();
    this.#visibleResponseIds.clear();
    this.#visualRequestedTurns.clear();
    this.#contextSessionId = null;
    await this.#conversation?.close();
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
      recordTestTrace("session.history", { history, configuration: event.configuration });
      let contextEvidence: string | undefined;
      if (event.configuration.contextSessionId) {
        try {
          this.#contextSessionId = event.configuration.contextSessionId.toLowerCase();
          const context = this.#conversationPort.supportsContextLookup
            ? await this.#contextService.getAvailable(this.#contextSessionId)
            : await this.#contextService.get(this.#contextSessionId);
          contextEvidence = formatVisualResult(context);
        } catch (error) {
          if (error instanceof ContextServiceError) {
            yield this.#error(event.sessionId, error.code, "The requested context is unavailable");
            return;
          }
          throw error;
        }
      }
      this.#conversation = await this.#conversationPort.open(
        {
          ...mapConfiguration(event.configuration),
          ...(contextEvidence ? { contextEvidence } : {}),
          ...((this.#contextSessionId || event.configuration.onDemandContext) &&
          this.#conversationPort.supportsContextLookup
            ? { contextLookupAvailable: true }
            : {}),
          history,
        },
        signal,
      );
      this.#onDemandContext =
        event.configuration.onDemandContext === true &&
        this.#conversationPort.supportsContextLookup === true;
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

    if (event.type === "context.capture.succeeded" || event.type === "context.capture.failed") {
      const requestId = event.requestId.toLowerCase();
      const turnId = event.turnId.toLowerCase();
      const pending = this.#pendingContextCaptures.get(requestId);
      if (!pending || pending.turnId.toLowerCase() !== turnId) {
        recordTestTrace("capture.rejected", {
          requestId,
          turnId,
          reason: "unknown-or-stale-request",
        });
        return;
      }
      clearTimeout(pending.timeout);
      if (pending.expiresAt <= this.#now()) {
        recordTestTrace("capture.rejected", { requestId, turnId, reason: "expired" });
        this.#pendingContextCaptures.delete(requestId);
        pending.abortController.abort();
        void this.#sendUnavailableContext(pending, "The context capture request expired.");
        return;
      }
      if (
        event.type === "context.capture.succeeded" &&
        (event.context.sessionId.toLowerCase() !== event.requestId.toLowerCase() ||
          new Date(event.context.capturedAt).getTime() <
            pending.requestedAt.getTime() - maximumCaptureClockSkewMs)
      ) {
        recordTestTrace("capture.rejected", { requestId, turnId, reason: "capture-mismatch" });
        this.#pendingContextCaptures.delete(requestId);
        pending.abortController.abort();
        void this.#sendUnavailableContext(
          pending,
          "The captured view does not match the current request.",
        );
        return;
      }
      if (event.type === "context.capture.failed") {
        this.#pendingContextCaptures.delete(requestId);
        pending.abortController.abort();
        void this.#sendUnavailableContext(
          pending,
          event.reason === "blocked"
            ? "Local privacy policy blocked access to the current view."
            : "The current view could not be captured.",
        );
        return;
      }
      void withTestTraceIds({ requestId, turnId }, () =>
        this.#resolveOnDemandContext(pending, event.context),
      ).catch(() => undefined);
      return;
    }

    if (event.type === "input.text") {
      this.#activeTurnId = event.turnId;
      this.#cancelPendingContextCaptures(event.turnId);
      this.#recordFinalText(event.turnId, event.text, signal);
      await this.#persistUserTurn(event.turnId, event.text);
    }
    if (event.type === "response.cancel") {
      const turnId = this.#responseTurnIds.get(canonicalId(event.responseId));
      if (turnId) this.#cancelContextCapturesForTurn(turnId);
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
    for await (const receivedOutput of conversation.outputs(signal)) {
      recordTestTrace("runtime.output", receivedOutput);
      if (receivedOutput.type === "response-started") {
        this.#responseTurnIds.set(canonicalId(receivedOutput.responseId), receivedOutput.turnId);
      }
      const deferredTurnId = responseTurnIdForDeferral(receivedOutput);
      if (this.#onDemandContext && deferredTurnId && !this.#finalTranscripts.has(deferredTurnId)) {
        const deferred = this.#deferredResponseOutputs.get(deferredTurnId) ?? [];
        deferred.push(receivedOutput);
        this.#deferredResponseOutputs.set(deferredTurnId, deferred);
        if (receivedOutput.type === "response-started") {
          recordTestTrace("routing.deferred", {
            turnId: deferredTurnId,
            reason: "waiting-for-final-transcript",
          });
        }
        continue;
      }
      const outputs =
        receivedOutput.type === "transcript" && receivedOutput.final
          ? [receivedOutput, ...(this.#deferredResponseOutputs.get(receivedOutput.turnId) ?? [])]
          : [receivedOutput];
      if (receivedOutput.type === "transcript" && receivedOutput.final) {
        this.#deferredResponseOutputs.delete(receivedOutput.turnId);
      }
      for (const output of outputs) {
        if (output.type === "context-request") {
          this.#responseTurnIds.set(canonicalId(output.responseId), output.turnId);
          if (this.#onDemandContext) {
            this.#deferredResponseOutputs.delete(output.turnId);
            if (this.#visibleResponseIds.delete(output.responseId) && this.#sessionId) {
              const cancelled = {
                responseId: output.responseId,
                type: "response-cancelled",
              } as const;
              await this.#persistOutput(cancelled);
              yield this.#mapOutput(this.#sessionId, cancelled);
            }
            if (this.#activeTurnId !== null && this.#activeTurnId !== output.turnId) {
              const unavailable = JSON.stringify({
                message: "The visual request no longer belongs to the current turn.",
                status: "unavailable",
              });
              await conversation.send({
                callId: output.callId,
                output: unavailable,
                type: "context-result",
              });
              continue;
            }
            const request = this.#beginContextCapture({
              callId: output.callId,
              conversation,
              query: this.#finalTranscripts.get(output.turnId) ?? output.query,
              turnId: output.turnId,
            });
            if (request) {
              yield request;
            }
          } else {
            void this.#resolveContextRequest(conversation, output, signal).catch(() => undefined);
          }
          continue;
        }
        if (output.type === "speech-started" || output.type === "speech-stopped") {
          this.#activeTurnId = output.turnId;
          this.#cancelPendingContextCaptures(output.turnId);
        }
        if (output.type === "transcript" && output.final) {
          this.#activeTurnId = output.turnId;
          this.#recordFinalText(output.turnId, output.text, signal);
        }
        if (
          output.type === "response-cancelled" &&
          this.#visualRequestedTurns.size > 0 &&
          !this.#visibleResponseIds.has(output.responseId)
        ) {
          continue;
        }
        await this.#persistOutput(output);
        if (output.type === "response-started") {
          this.#visibleResponseIds.add(output.responseId);
        } else if (output.type === "response-completed" || output.type === "response-cancelled") {
          this.#visibleResponseIds.delete(output.responseId);
          this.#responseTurnIds.delete(canonicalId(output.responseId));
        }
        if (!this.#sessionId) {
          return;
        }
        yield this.#mapOutput(this.#sessionId, output);
        if (output.type === "response-completed") {
          const shouldEnd = await this.#takeEndIntent(output.turnId);
          this.#finalTranscripts.delete(output.turnId);
          if (shouldEnd) {
            yield {
              reason: "user_intent",
              turnId: output.turnId,
              ...this.#baseEvent(this.#sessionId),
              type: "session.end_requested",
            };
          }
        }
      }
    }
  }

  #recordFinalText(turnId: string, text: string, signal?: AbortSignal): void {
    this.#finalTranscripts.set(turnId, text);
    this.#endIntentByTurn.get(turnId)?.abortController.abort();
    const abortController = new AbortController();
    const classifierSignal = signal
      ? AbortSignal.any([signal, abortController.signal])
      : abortController.signal;
    this.#endIntentByTurn.set(turnId, {
      abortController,
      result: this.#conversationEndIntent
        .shouldEnd({ text, turnId }, classifierSignal)
        .catch(() => false),
    });
  }

  async #takeEndIntent(turnId: string): Promise<boolean> {
    const pending = this.#endIntentByTurn.get(turnId);
    this.#endIntentByTurn.delete(turnId);
    if (!pending) {
      return false;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending.result,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => {
            pending.abortController.abort();
            resolve(false);
          }, this.#endIntentWaitMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  #beginContextCapture(input: {
    readonly callId: string;
    readonly conversation: RealtimeConversation;
    readonly query: string;
    readonly turnId: string;
  }): RealtimeServerEvent | null {
    if (!this.#sessionId || this.#visualRequestedTurns.has(input.turnId)) {
      recordTestTrace("capture.skipped", {
        turnId: input.turnId,
        reason: "already-requested-or-no-session",
      });
      return null;
    }
    this.#visualRequestedTurns.add(input.turnId);
    const requestId = this.#generateId();
    const requestedAt = this.#now();
    const expiresAt = new Date(requestedAt.getTime() + 15_000);
    const abortController = new AbortController();
    const pending: PendingContextCapture = {
      abortController,
      callId: input.callId,
      conversation: input.conversation,
      expiresAt,
      query: input.query,
      requestId,
      requestedAt,
      timeout: setTimeout(() => {
        if (this.#pendingContextCaptures.delete(requestId)) {
          abortController.abort();
          this.#clearVisualTurn(input.turnId);
          void this.#sendUnavailableContext(pending, "The current view was not captured in time.");
        }
      }, 15_000),
      turnId: input.turnId,
    };
    this.#pendingContextCaptures.set(requestId, pending);
    recordTestTrace("capture.requested", {
      requestId,
      turnId: input.turnId,
      callId: input.callId,
      question: input.query,
      expiresAt,
      source: "model-tool",
    });
    return {
      expiresAt: expiresAt.toISOString(),
      requestId,
      turnId: input.turnId,
      ...this.#baseEvent(this.#sessionId),
      type: "context.capture.requested",
    };
  }

  #clearVisualTurn(turnId: string): void {
    this.#visualRequestedTurns.delete(turnId);
  }

  #cancelPendingContextCaptures(activeTurnId?: string): void {
    for (const turnId of this.#deferredResponseOutputs.keys()) {
      if (turnId !== activeTurnId) {
        this.#deferredResponseOutputs.delete(turnId);
      }
    }
    for (const [requestId, pending] of this.#pendingContextCaptures) {
      if (pending.turnId === activeTurnId) {
        continue;
      }
      this.#pendingContextCaptures.delete(requestId);
      clearTimeout(pending.timeout);
      pending.abortController.abort();
      recordTestTrace("capture.cancelled", { requestId, turnId: pending.turnId, activeTurnId });
      this.#clearVisualTurn(pending.turnId);
    }
    for (const turnId of this.#finalTranscripts.keys()) {
      if (turnId !== activeTurnId) {
        this.#finalTranscripts.delete(turnId);
        this.#endIntentByTurn.delete(turnId);
        this.#clearVisualTurn(turnId);
      }
    }
  }

  #cancelContextCapturesForTurn(turnId: string): void {
    this.#deferredResponseOutputs.delete(turnId);
    for (const [requestId, pending] of this.#pendingContextCaptures) {
      if (pending.turnId !== turnId) continue;
      this.#pendingContextCaptures.delete(requestId);
      clearTimeout(pending.timeout);
      pending.abortController.abort();
      recordTestTrace("capture.cancelled", { requestId, turnId });
      this.#clearVisualTurn(turnId);
    }
    this.#finalTranscripts.delete(turnId);
    this.#endIntentByTurn.delete(turnId);
  }

  async #resolveOnDemandContext(
    pending: PendingContextCapture,
    envelope: Extract<
      RealtimeClientEvent,
      { readonly type: "context.capture.succeeded" }
    >["context"],
  ): Promise<void> {
    try {
      const question = this.#finalTranscripts.get(pending.turnId) ?? pending.query;
      await this.#contextService.submit(envelope, pending.abortController.signal, question);
      const context = await this.#contextService.get(envelope.sessionId);
      pending.abortController.signal.throwIfAborted();
      const result = formatVisualResult(context);
      recordTestTrace("grounding.result", {
        question,
        context,
        result: JSON.parse(result),
      });
      this.#clearVisualTurn(pending.turnId);
      await this.#sendResolvedContext(pending, result);
    } catch (error) {
      recordTestTrace("capture.resolve.failed", {
        error: error instanceof Error ? error.message : "unknown",
        aborted: pending.abortController.signal.aborted,
      });
      if (pending.abortController.signal.aborted) {
        return;
      }
      await this.#sendUnavailableContext(
        pending,
        "The current view could not be understood reliably.",
      );
    } finally {
      if (this.#pendingContextCaptures.get(pending.requestId) === pending) {
        this.#pendingContextCaptures.delete(pending.requestId);
      }
      await this.#contextService.delete(envelope.sessionId).catch(() => undefined);
      recordTestTrace("context.deleted", { requestId: pending.requestId, turnId: pending.turnId });
    }
  }

  async #sendUnavailableContext(pending: PendingContextCapture, message: string): Promise<void> {
    this.#clearVisualTurn(pending.turnId);
    await this.#sendResolvedContext(
      pending,
      JSON.stringify({ message, status: "unavailable" }),
    ).catch(() => undefined);
  }

  async #sendResolvedContext(pending: PendingContextCapture, output: string): Promise<void> {
    if (this.#closed) return;
    recordTestTrace("tool.result", {
      turnId: pending.turnId,
      requestId: pending.requestId,
      callId: pending.callId,
      output,
    });
    await pending.conversation.send({
      callId: pending.callId,
      output,
      type: "context-result",
    });
  }

  async #resolveContextRequest(
    conversation: RealtimeConversation,
    output: Extract<RealtimeConversationOutput, { readonly type: "context-request" }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const contextSessionId = this.#contextSessionId;
    let result: string;
    if (!contextSessionId) {
      result = JSON.stringify({
        message: "No active visual context is available.",
        status: "unavailable",
      });
    } else {
      try {
        const context = await this.#contextService.get(contextSessionId);
        result = formatVisualResult(context);
      } catch (error) {
        result = JSON.stringify({
          message:
            error instanceof ContextServiceError
              ? "The visual context expired or was cleared."
              : "The visual context could not be resolved.",
          status: "unavailable",
        });
      }
    }
    await conversation.send(
      {
        callId: output.callId,
        output: result,
        type: "context-result",
      },
      signal,
    );
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
        recordTestTrace("answer.completed", {
          turnId: output.turnId,
          responseId: output.responseId,
          text: content ?? "",
        });
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
        recordTestTrace("answer.cancelled", {
          responseId: output.responseId,
          text: this.#assistantContent.get(output.responseId) ?? "",
        });
        this.#assistantContent.delete(output.responseId);
        break;
      case "error":
      case "context-request":
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
      case "context-request":
        throw new Error("Context requests must be resolved inside the realtime session");
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

function responseTurnIdForDeferral(output: RealtimeConversationOutput): string | undefined {
  switch (output.type) {
    case "response-audio":
    case "response-completed":
    case "response-started":
    case "response-text":
      return output.turnId;
    case "context-request":
    case "error":
    case "response-cancelled":
    case "speech-started":
    case "speech-stopped":
    case "transcript":
      return undefined;
  }
}

function mapInput(
  event: Exclude<
    RealtimeClientEvent,
    {
      readonly type:
        | "context.capture.failed"
        | "context.capture.succeeded"
        | "session.close"
        | "session.configure";
    }
  >,
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
