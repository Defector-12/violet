import { createHash, randomUUID } from "node:crypto";
import type { RealtimeConversationInput, RealtimeConversationOutput } from "@violet/domain";
import { describe, expect, it, vi } from "vitest";
import { ContextService } from "../context/context-service.js";
import { DeterministicContextUnderstandingPort } from "../context/deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "../context/in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "../context/in-memory-context-session-repository.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import type { ConversationEndIntentPort } from "./conversation-end-intent.js";
import { DeterministicRealtimeConversationPort } from "./deterministic-realtime-conversation.js";
import { RealtimeSession } from "./realtime-session.js";

describe("RealtimeSession", () => {
  it("configures once and preserves independent client and server sequences", async () => {
    const sessionId = randomUUID();
    const { ledger, session } = createSession();

    const ready = await collect(
      session.handle({
        configuration: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );
    const responsePromise = take(session.outputs(), 3);
    const immediate = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Hello",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const response = await responsePromise;

    expect(ready).toMatchObject([
      {
        capabilities: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          runtimeKind: "deterministic",
        },
        sequence: 1,
        sessionId,
        type: "session.ready",
      },
    ]);
    expect(response.map((event) => [event.sequence, event.type])).toEqual([
      [2, "response.started"],
      [3, "response.text"],
      [4, "response.completed"],
    ]);
    expect(immediate).toEqual([]);
    await expect(ledger.list()).resolves.toMatchObject([
      {
        content: "Hello",
        role: "user",
      },
      {
        content: "Violet realtime test response: Hello",
        role: "assistant",
      },
    ]);
  });

  it("returns the audio formats negotiated by the adapter", async () => {
    const sessionId = randomUUID();
    const ledger = new InMemoryConversationLedger();
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      conversationPort: {
        async open() {
          return {
            capabilities: {
              inputAudio: {
                channels: 1,
                encoding: "pcm_s16le",
                sampleRate: 16000,
              },
              inputModalities: ["audio", "text"],
              interruption: false,
              outputAudio: {
                channels: 1,
                encoding: "pcm_s16le",
                sampleRate: 24000,
              },
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            } as const,
            async close() {},
            async *outputs() {},
            async send() {},
          };
        },
      },
      contextService: createContextService(),
      generateId: randomUUID,
      ledger,
    });

    const ready = await collect(
      session.handle({
        configuration: {
          inputAudio: {
            channels: 1,
            encoding: "pcm_s16le",
            sampleRate: 16000,
          },
          inputModalities: ["audio", "text"],
          outputAudio: {
            channels: 1,
            encoding: "pcm_s16le",
            sampleRate: 24000,
          },
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(ready[0]).toMatchObject({
      capabilities: {
        inputAudio: { sampleRate: 16000 },
        outputAudio: { sampleRate: 24000 },
        turnDetection: "smart_turn",
      },
      type: "session.ready",
    });
  });

  it("emits an end request after the farewell response completes", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const responseId = randomUUID();
    const session = new RealtimeSession({
      conversationEndIntent: {
        async shouldEnd(input) {
          expect(input).toEqual({ text: "拜拜，就先这样吧", turnId });
          return true;
        },
      },
      conversationPort: {
        async open() {
          return {
            capabilities: {
              inputModalities: ["audio"],
              interruption: true,
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            } as const,
            async close() {},
            async *outputs() {
              yield {
                final: true,
                text: "拜拜，就先这样吧",
                turnId,
                type: "transcript",
              } as const;
              yield {
                responseId,
                turnId,
                type: "response-started",
              } as const;
              yield {
                inputTokens: 1,
                outputTokens: 1,
                responseId,
                turnId,
                type: "response-completed",
              } as const;
            },
            async send() {},
          };
        },
      },
      contextService: createContextService(),
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });
    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    const output = await collect(session.outputs());

    expect(output).toMatchObject([
      {
        sequence: 2,
        type: "input.transcript",
      },
      {
        sequence: 3,
        type: "response.started",
      },
      {
        sequence: 4,
        type: "response.completed",
      },
      {
        reason: "user_intent",
        sequence: 5,
        sessionId,
        turnId,
        type: "session.end_requested",
      },
    ]);
  });

  it("seeds a new realtime runtime with recent ledger history", async () => {
    const sessionId = randomUUID();
    const ledger = new InMemoryConversationLedger();
    await ledger.append({
      content: "Earlier question",
      id: randomUUID(),
      occurredAt: new Date("2026-08-22T00:00:00.000Z"),
      requestId: randomUUID(),
      role: "user",
    });
    await ledger.append({
      content: "Earlier answer",
      id: randomUUID(),
      occurredAt: new Date("2026-08-22T00:00:01.000Z"),
      requestId: randomUUID(),
      role: "assistant",
    });
    let observedConfiguration: Parameters<DeterministicRealtimeConversationPort["open"]>[0] | null =
      null;
    const deterministic = new DeterministicRealtimeConversationPort({
      generateId: randomUUID,
    });
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      conversationPort: {
        async open(configuration, signal) {
          observedConfiguration = configuration;
          return deterministic.open(configuration, signal);
        },
      },
      contextService: createContextService(),
      generateId: randomUUID,
      ledger,
    });

    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio", "text"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(observedConfiguration).toMatchObject({
      history: [
        { content: "Earlier question", role: "user" },
        { content: "Earlier answer", role: "assistant" },
      ],
      turnDetection: "smart_turn",
    });
  });

  it("resolves an active context before opening the realtime provider", async () => {
    const sessionId = randomUUID();
    const contextSessionId = randomUUID();
    const contextService = createContextService();
    const capturedAt = new Date();
    await contextService.submit({
      authorization: {
        controlledSensitiveAllowed: false,
        grantId: randomUUID(),
        mode: "explicit",
        purpose: "conversation",
        retention: "ephemeral",
      },
      capturedAt: capturedAt.toISOString(),
      completeness: 1,
      confidence: 1,
      eventId: randomUUID(),
      expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
      payload: {
        text: "Current selected evidence",
        type: "focus.text",
      },
      protocolVersion: "1",
      redactions: [],
      sensitivity: "personal",
      sequence: 1,
      sessionId: contextSessionId,
      source: {
        deviceId: randomUUID(),
        modality: "accessibility",
      },
    });
    let observedConfiguration: Parameters<DeterministicRealtimeConversationPort["open"]>[0] | null =
      null;
    const deterministic = new DeterministicRealtimeConversationPort({
      generateId: randomUUID,
    });
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService,
      conversationPort: {
        supportsContextLookup: true,
        async open(configuration, signal) {
          observedConfiguration = configuration;
          return deterministic.open(configuration, signal);
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });

    await collect(
      session.handle({
        configuration: {
          contextSessionId,
          inputModalities: ["audio", "text"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(observedConfiguration).toMatchObject({
      contextEvidence: expect.stringContaining("Current selected evidence"),
      contextLookupAvailable: true,
    });
  });

  it("does not expose a low-confidence image as ready context evidence", async () => {
    const sessionId = randomUUID();
    const contextSessionId = randomUUID();
    const contextService = new ContextService({
      artifactStore: new InMemoryContextArtifactStore(),
      repository: new InMemoryContextSessionRepository(),
      understanding: {
        async understand() {
          return {
            answer: "Maybe the label is EMBER.",
            confidence: 0.69,
            model: "test",
            provider: "test",
            summary: "Maybe the label is EMBER.",
          };
        },
      },
    });
    const capturedAt = new Date();
    await contextService.submit(
      imageContextEnvelope(contextSessionId, capturedAt, { x: 0.5, y: 0.5 }),
    );
    await contextService.get(contextSessionId);
    let observedConfiguration: Parameters<DeterministicRealtimeConversationPort["open"]>[0] | null =
      null;
    const deterministic = new DeterministicRealtimeConversationPort({
      generateId: randomUUID,
    });
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService,
      conversationPort: {
        supportsContextLookup: true,
        async open(configuration, signal) {
          observedConfiguration = configuration;
          return deterministic.open(configuration, signal);
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });

    await collect(
      session.handle({
        configuration: {
          contextSessionId,
          inputModalities: ["audio", "text"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    expect(observedConfiguration).toMatchObject({
      contextEvidence: expect.stringContaining('"status":"unavailable"'),
    });
    expect(JSON.stringify(observedConfiguration)).not.toContain("Maybe the label is EMBER.");
  });

  it("resolves provider context requests without exposing them to the client", async () => {
    const sessionId = randomUUID();
    const contextSessionId = randomUUID();
    const contextService = createContextService();
    const capturedAt = new Date();
    await contextService.submit({
      authorization: {
        controlledSensitiveAllowed: false,
        grantId: randomUUID(),
        mode: "explicit",
        purpose: "conversation",
        retention: "ephemeral",
      },
      capturedAt: capturedAt.toISOString(),
      completeness: 1,
      confidence: 1,
      eventId: randomUUID(),
      expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
      payload: {
        text: "The pointed word is continuity.",
        type: "focus.text",
      },
      protocolVersion: "1",
      redactions: [],
      sensitivity: "personal",
      sequence: 1,
      sessionId: contextSessionId,
      source: {
        deviceId: randomUUID(),
        modality: "accessibility",
      },
    });
    const receivedInputs: RealtimeConversationInput[] = [];
    const responseId = randomUUID();
    const turnId = randomUUID();
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService,
      conversationPort: {
        supportsContextLookup: true,
        async open() {
          return {
            capabilities: {
              inputModalities: ["audio"],
              interruption: true,
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            },
            async close() {},
            async *outputs() {
              yield {
                callId: "call-context",
                query: "What does this word mean?",
                responseId,
                turnId,
                type: "context-request",
              } as const;
              yield { responseId, turnId, type: "response-started" } as const;
              yield {
                responseId,
                text: "It means continuity.",
                turnId,
                type: "response-text",
              } as const;
              yield {
                inputTokens: 4,
                outputTokens: 4,
                responseId,
                turnId,
                type: "response-completed",
              } as const;
            },
            async send(input) {
              receivedInputs.push(input);
            },
          };
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });
    await collect(
      session.handle({
        configuration: {
          contextSessionId,
          inputModalities: ["audio"],
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    const output = await collect(session.outputs());
    await waitUntil(() => receivedInputs.length === 1);

    expect(output.map((event) => event.type)).toEqual([
      "response.started",
      "response.text",
      "response.completed",
    ]);
    expect(receivedInputs).toMatchObject([
      {
        callId: "call-context",
        output: expect.stringContaining("The pointed word is continuity."),
        type: "context-result",
      },
    ]);
  });

  it("accepts uppercase Swift UUIDs and normal cross-device clock skew", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const responseId = randomUUID();
    const receivedInputs: RealtimeConversationInput[] = [];
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService: createContextService(),
      conversationPort: {
        supportsContextLookup: true,
        async open() {
          return {
            capabilities: {
              inputModalities: ["audio"],
              interruption: true,
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            },
            async close() {},
            async *outputs() {
              yield { responseId, turnId, type: "response-started" } as const;
              yield {
                callId: "call-current-view",
                query: "这个词是什么意思？",
                responseId,
                turnId,
                type: "context-request",
              } as const;
            },
            async send(input) {
              receivedInputs.push(input);
            },
          };
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });
    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio"],
          onDemandContext: true,
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    const output = await collect(session.outputs());
    expect(output.map((event) => event.type)).toEqual(["context.capture.requested"]);
    const request = output.find((event) => event.type === "context.capture.requested");
    expect(request).toMatchObject({
      turnId,
      type: "context.capture.requested",
    });
    if (request?.type !== "context.capture.requested") {
      throw new Error("Expected a context capture request");
    }
    const capturedAt = new Date(Date.now() - 1_000);
    await collect(
      session.handle({
        context: contextEnvelope("ephemeral", request.requestId.toLowerCase(), capturedAt),
        eventId: randomUUID(),
        requestId: request.requestId.toUpperCase(),
        sequence: 2,
        sessionId,
        turnId: turnId.toUpperCase(),
        type: "context.capture.succeeded",
      }),
    );
    await waitUntil(() => receivedInputs.length === 1);

    expect(receivedInputs).toMatchObject([
      {
        callId: "call-current-view",
        output: expect.stringContaining("Selected text:\\nephemeral"),
        type: "context-result",
      },
    ]);
  });

  it("accepts a reliable visual answer without re-grounding its target", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const responseId = randomUUID();
    const receivedInputs: RealtimeConversationInput[] = [];
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService: new ContextService({
        artifactStore: new InMemoryContextArtifactStore(),
        repository: new InMemoryContextSessionRepository(),
        understanding: {
          async understand() {
            return {
              answer: "右下角绿色按钮用于发送消息。",
              confidence: 0.95,
              model: "test",
              provider: "test",
              summary: "右下角绿色按钮用于发送消息。",
            };
          },
        },
      }),
      conversationPort: {
        supportsContextLookup: true,
        async open() {
          return {
            capabilities: {
              inputModalities: ["audio"],
              interruption: true,
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            },
            async close() {},
            async *outputs() {
              yield {
                final: true,
                text: "右下角绿色按钮有什么作用？",
                turnId,
                type: "transcript",
              } as const;
              yield {
                callId: "visual-answer",
                query: "右下角绿色按钮有什么作用？",
                responseId,
                turnId,
                type: "context-request",
              } as const;
            },
            async send(input) {
              receivedInputs.push(input);
            },
          };
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });
    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio"],
          onDemandContext: true,
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    const output = await collect(session.outputs());
    expect(output.map((event) => event.type)).toEqual([
      "input.transcript",
      "context.capture.requested",
    ]);
    const request = output[1];
    if (request?.type !== "context.capture.requested") {
      throw new Error("Expected a context capture request");
    }
    await collect(
      session.handle({
        context: imageContextEnvelope(request.requestId, new Date(), { x: 0.1, y: 0.1 }),
        eventId: randomUUID(),
        requestId: request.requestId,
        sequence: 2,
        sessionId,
        turnId,
        type: "context.capture.succeeded",
      }),
    );
    await waitUntil(() => receivedInputs.some((input) => input.type === "context-result"));

    const result = receivedInputs.find((input) => input.type === "context-result");
    expect(result).toMatchObject({
      callId: "visual-answer",
      type: "context-result",
    });
    expect(result?.type === "context-result" && JSON.parse(result.output)).toMatchObject({
      answer: "右下角绿色按钮用于发送消息。",
      status: "ready",
    });
  });

  it("buffers early response output until the final transcript arrives", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const responseId = randomUUID();
    const receivedInputs: RealtimeConversationInput[] = [];
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService: createContextService(),
      conversationPort: {
        supportsContextLookup: true,
        async open() {
          return {
            capabilities: {
              inputModalities: ["audio"],
              interruption: true,
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            },
            async close() {},
            async *outputs() {
              yield { responseId, turnId, type: "response-started" } as const;
              yield {
                audio: Uint8Array.from([1, 2]),
                responseId,
                turnId,
                type: "response-audio",
              } as const;
              yield {
                final: true,
                text: "我选中的代码是什么意思？",
                turnId,
                type: "transcript",
              } as const;
              yield {
                audio: Uint8Array.from([3, 4]),
                responseId,
                turnId,
                type: "response-audio",
              } as const;
              yield {
                inputTokens: 1,
                outputTokens: 1,
                responseId,
                turnId,
                type: "response-completed",
              } as const;
            },
            async send(input) {
              receivedInputs.push(input);
            },
          };
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });
    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio"],
          onDemandContext: true,
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    const output = await collect(session.outputs());

    expect(output.map((event) => event.type)).toEqual([
      "input.transcript",
      "response.started",
      "response.audio",
      "response.audio",
      "response.completed",
    ]);
    expect(receivedInputs).toEqual([]);
  });

  it("ignores a stale capture result after a newer speech turn starts", async () => {
    const sessionId = randomUUID();
    const oldTurnId = randomUUID();
    const newTurnId = randomUUID();
    const responseId = randomUUID();
    const session = new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      contextService: createContextService(),
      conversationPort: {
        supportsContextLookup: true,
        async open() {
          return {
            capabilities: {
              inputModalities: ["audio"],
              interruption: true,
              outputModalities: ["audio", "text"],
              runtimeKind: "integrated",
              transcription: true,
              turnDetection: "smart_turn",
              voiceKind: "preset",
            },
            async close() {},
            async *outputs() {
              yield {
                callId: "old-call",
                query: "What is this?",
                responseId,
                turnId: oldTurnId,
                type: "context-request",
              } as const;
              yield {
                turnId: newTurnId,
                type: "speech-started",
              } as const;
            },
            async send() {},
          };
        },
      },
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
    });
    await collect(
      session.handle({
        configuration: {
          inputModalities: ["audio"],
          onDemandContext: true,
          outputModalities: ["audio", "text"],
          protocolVersion: "1",
          turnDetection: "smart_turn",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );
    const output = await collect(session.outputs());
    const request = output[0];
    if (request?.type !== "context.capture.requested") {
      throw new Error("Expected a context capture request");
    }

    const staleResult = await collect(
      session.handle({
        context: contextEnvelope("stale evidence", request.requestId, new Date()),
        eventId: randomUUID(),
        requestId: request.requestId,
        sequence: 2,
        sessionId,
        turnId: oldTurnId,
        type: "context.capture.succeeded",
      }),
    );

    expect(output.map((event) => event.type)).toEqual([
      "context.capture.requested",
      "input.speech.started",
    ]);
    expect(staleResult).toEqual([]);
  });

  describe("text turns with on-demand context", () => {
    async function fixture(
      events: RealtimeConversationOutput[],
      onDemandContext = true,
      contextService = createContextService(),
      close = async () => {},
    ) {
      const receivedInputs: RealtimeConversationInput[] = [];
      const ledger = new InMemoryConversationLedger();
      const sessionId = randomUUID();
      const session = new RealtimeSession({
        conversationEndIntent: neverEndsConversation,
        conversationPort: {
          supportsContextLookup: true,
          async open() {
            return {
              capabilities: {
                inputModalities: ["text"],
                interruption: true,
                outputModalities: ["text"],
                runtimeKind: "integrated",
                transcription: true,
                turnDetection: "server_vad",
                voiceKind: "preset",
              },
              close,
              async *outputs() {
                yield* events;
              },
              async send(input) {
                receivedInputs.push(input);
              },
            };
          },
        },
        contextService,
        generateId: randomUUID,
        ledger,
      });
      await collect(
        session.handle({
          configuration: {
            inputModalities: ["text"],
            onDemandContext,
            outputModalities: ["text"],
            protocolVersion: "1",
          },
          eventId: randomUUID(),
          sequence: 1,
          sessionId,
          type: "session.configure",
        }),
      );
      let sequence = 2;
      const sendText = (text: string, turnId: string) =>
        collect(
          session.handle({
            eventId: randomUUID(),
            sequence: sequence++,
            sessionId,
            text,
            turnId,
            type: "input.text",
          }),
        );
      return { contextService, ledger, receivedInputs, sendText, session, sessionId };
    }

    it.each([true, false])(
      "delivers ordinary text responses without a transcript event (Look=%s)",
      async (onDemandContext) => {
        const turnId = randomUUID();
        const responseId = randomUUID();
        const { ledger, sendText, session } = await fixture(
          [
            { responseId, turnId, type: "response-started" },
            {
              responseId,
              text: "A closure retains its lexical scope.",
              turnId,
              type: "response-text",
            },
            { inputTokens: 1, outputTokens: 1, responseId, turnId, type: "response-completed" },
          ],
          onDemandContext,
        );
        try {
          await sendText("Explain closures.", turnId);
          const output = await collect(session.outputs());
          expect(output.map((event) => event.type)).toEqual([
            "response.started",
            "response.text",
            "response.completed",
          ]);
          expect(await ledger.list()).toMatchObject([
            { content: "Explain closures.", role: "user" },
            { content: "A closure retains its lexical scope.", role: "assistant" },
          ]);
        } finally {
          await session.close();
        }
      },
    );

    it.each([true, false])(
      "does not infer visual routing from transcript keywords (Look=%s)",
      async (onDemandContext) => {
        const turnId = randomUUID();
        const responseId = randomUUID();
        const { receivedInputs, sendText, session } = await fixture(
          [
            { responseId, turnId, type: "response-started" },
            { responseId, text: "Ungrounded guess.", turnId, type: "response-text" },
          ],
          onDemandContext,
        );
        try {
          await sendText("当前页面的时间和地点是什么？", turnId);
          const output = await collect(session.outputs());
          expect(output.map((event) => event.type)).toEqual(["response.started", "response.text"]);
          expect(receivedInputs.filter((input) => input.type === "cancel")).toEqual([]);
        } finally {
          await session.close();
        }
      },
    );

    it("ignores cancellation for an unknown response without suppressing the current turn", async () => {
      const events: RealtimeConversationOutput[] = [];
      const turnId = randomUUID();
      const responseId = randomUUID();
      const { sendText, session, sessionId } = await fixture(events);
      try {
        await sendText("Current question", turnId);
        await collect(
          session.handle({
            eventId: randomUUID(),
            responseId: randomUUID(),
            sequence: 3,
            sessionId,
            type: "response.cancel",
          }),
        );
        events.push(
          { responseId, turnId, type: "response-started" },
          { responseId, text: "Current answer", turnId, type: "response-text" },
          { inputTokens: 1, outputTokens: 1, responseId, turnId, type: "response-completed" },
        );
        expect((await collect(session.outputs())).map((event) => event.type)).toEqual([
          "response.started",
          "response.text",
          "response.completed",
        ]);
      } finally {
        await session.close();
      }
    });

    it("returns unavailable for a late visual tool call from a retired turn", async () => {
      const events: RealtimeConversationOutput[] = [];
      const oldTurnId = randomUUID();
      const { receivedInputs, sendText, session } = await fixture(events);
      try {
        await sendText("Old visual question", oldTurnId);
        await sendText("New question", randomUUID());
        events.push({
          callId: "late-call",
          query: "Old visual question",
          responseId: randomUUID(),
          turnId: oldTurnId,
          type: "context-request",
        });

        expect(await collect(session.outputs())).toEqual([]);
        expect(receivedInputs.at(-1)).toMatchObject({
          callId: "late-call",
          output: expect.stringContaining('"status":"unavailable"'),
          type: "context-result",
        });
      } finally {
        await session.close();
      }
    });

    it("rejects the previous capture when a new text turn starts", async () => {
      const oldTurnId = randomUUID();
      const { contextService, sendText, session, sessionId } = await fixture([
        {
          callId: "old-call",
          query: "What is this?",
          responseId: randomUUID(),
          turnId: oldTurnId,
          type: "context-request",
        },
      ]);
      const submit = vi.spyOn(contextService, "submit");
      try {
        const output = await collect(session.outputs());
        const request = output[0];
        if (request?.type !== "context.capture.requested") {
          throw new Error("Expected a context request");
        }
        await sendText("Now explain closures instead.", randomUUID());
        await collect(
          session.handle({
            context: contextEnvelope("stale evidence", request.requestId, new Date()),
            eventId: randomUUID(),
            requestId: request.requestId,
            sequence: 3,
            sessionId,
            turnId: oldTurnId,
            type: "context.capture.succeeded",
          }),
        );
        expect(submit).not.toHaveBeenCalled();
      } finally {
        await session.close();
        submit.mockRestore();
      }
    });

    it.each(["new-turn", "cancel", "close"] as const)(
      "cancels in-flight vision on %s before accepting any late answer",
      async (action) => {
        let finish = () => {};
        let finishClose = () => {};
        const vision = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const closing = new Promise<void>((resolve) => {
          finishClose = resolve;
        });
        let signal: AbortSignal | undefined;
        const contextService = new ContextService({
          repository: new InMemoryContextSessionRepository(),
          artifactStore: new InMemoryContextArtifactStore(),
          understanding: {
            async understand(_request, incomingSignal) {
              signal = incomingSignal;
              await vision;
              return {
                confidence: 1,
                model: "test",
                provider: "test",
                summary: "Late image answer",
              };
            },
          },
        });
        const turnId = randomUUID();
        const responseId = randomUUID();
        const f = await fixture(
          [
            {
              callId: "pending-call",
              query: "What is this?",
              responseId,
              turnId,
              type: "context-request",
            },
          ],
          true,
          contextService,
          () => closing,
        );
        const deleted = vi.spyOn(contextService, "delete");
        let closeTask: Promise<void> | undefined;
        try {
          const [request] = await collect(f.session.outputs());
          if (request?.type !== "context.capture.requested") throw new Error("No capture request");
          await collect(
            f.session.handle({
              type: "context.capture.succeeded",
              requestId: request.requestId,
              turnId,
              context: imageContextEnvelope(request.requestId, new Date(), { x: 0.5, y: 0.5 }),
              eventId: randomUUID(),
              sequence: 2,
              sessionId: f.sessionId,
            }),
          );
          await waitUntil(() => signal !== undefined);
          if (action === "close") closeTask = f.session.close();
          else
            await collect(
              f.session.handle({
                ...(action === "cancel"
                  ? { type: "response.cancel" as const, responseId: responseId.toUpperCase() }
                  : {
                      type: "input.text" as const,
                      text: "Explain closures.",
                      turnId: randomUUID(),
                    }),
                eventId: randomUUID(),
                sequence: 3,
                sessionId: f.sessionId,
              }),
            );
          expect(signal?.aborted).toBe(true);
          finish();
          await waitUntil(() => deleted.mock.calls.length > 0);
          expect(f.receivedInputs.filter((input) => input.type === "context-result")).toEqual([]);
        } finally {
          finish();
          finishClose();
          await closeTask;
          await f.session.close();
        }
      },
    );

    it("refuses provider-initiated capture with Look off", async () => {
      const f = await fixture(
        [
          {
            callId: "unexpected-tool",
            query: "Read the screen",
            responseId: randomUUID(),
            turnId: randomUUID(),
            type: "context-request",
          },
        ],
        false,
      );
      const submit = vi.spyOn(f.contextService, "submit");
      try {
        expect(await collect(f.session.outputs())).toEqual([]);
        await waitUntil(() => f.receivedInputs.length === 1);
        expect(f.receivedInputs[0]).toMatchObject({
          type: "context-result",
          output: expect.stringContaining('"status":"unavailable"'),
        });
        expect(submit).not.toHaveBeenCalled();
      } finally {
        await f.session.close();
      }
    });
  });

  it("rejects out-of-order and mismatched events without advancing client state", async () => {
    const sessionId = randomUUID();
    const { session } = createSession();
    await collect(
      session.handle({
        configuration: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        type: "session.configure",
      }),
    );

    const outOfOrder = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 3,
        sessionId,
        text: "Skipped sequence two",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const wrongSession = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 2,
        sessionId: randomUUID(),
        text: "Wrong session",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const acceptedEventId = randomUUID();
    const responsePromise = take(session.outputs(), 3);
    const accepted = await collect(
      session.handle({
        eventId: acceptedEventId,
        sequence: 2,
        sessionId,
        text: "Correct",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );
    const response = await responsePromise;
    const duplicate = await collect(
      session.handle({
        eventId: acceptedEventId,
        sequence: 3,
        sessionId,
        text: "Replay",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );

    expect(outOfOrder[0]).toMatchObject({
      code: "INVALID_EVENT_SEQUENCE",
      type: "error",
    });
    expect(wrongSession[0]).toMatchObject({
      code: "SESSION_ID_MISMATCH",
      type: "error",
    });
    expect(accepted).toEqual([]);
    expect(response.map((event) => event.type)).toEqual([
      "response.started",
      "response.text",
      "response.completed",
    ]);
    expect(duplicate[0]).toMatchObject({
      code: "DUPLICATE_EVENT",
      type: "error",
    });
  });

  it("requires configuration before input and closes without provider output", async () => {
    const sessionId = randomUUID();
    const { session } = createSession();
    const beforeConfiguration = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 1,
        sessionId,
        text: "Too early",
        turnId: randomUUID(),
        type: "input.text",
      }),
    );

    expect(beforeConfiguration[0]).toMatchObject({
      code: "SESSION_NOT_CONFIGURED",
      type: "error",
    });

    await collect(
      session.handle({
        configuration: {
          inputModalities: ["text"],
          outputModalities: ["text"],
          protocolVersion: "1",
        },
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        type: "session.configure",
      }),
    );
    const closeEvents = await collect(
      session.handle({
        eventId: randomUUID(),
        sequence: 3,
        sessionId,
        type: "session.close",
      }),
    );

    expect(closeEvents).toEqual([]);
    expect(session.closed).toBe(true);
  });
});

function createSession(): {
  readonly ledger: InMemoryConversationLedger;
  readonly session: RealtimeSession;
} {
  let id = 0;
  const generateId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const ledger = new InMemoryConversationLedger();
  return {
    ledger,
    session: new RealtimeSession({
      conversationEndIntent: neverEndsConversation,
      conversationPort: new DeterministicRealtimeConversationPort({ generateId }),
      contextService: createContextService(),
      generateId,
      ledger,
    }),
  };
}

const neverEndsConversation: ConversationEndIntentPort = {
  async shouldEnd() {
    return false;
  },
};

function contextEnvelope(text: string, sessionId: string, capturedAt: Date) {
  return {
    authorization: {
      controlledSensitiveAllowed: false,
      grantId: randomUUID(),
      mode: "explicit" as const,
      purpose: "conversation" as const,
      retention: "ephemeral" as const,
    },
    capturedAt: capturedAt.toISOString(),
    completeness: 1,
    confidence: 1,
    eventId: randomUUID(),
    expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
    payload: {
      text,
      type: "focus.text" as const,
    },
    protocolVersion: "1" as const,
    redactions: [],
    sensitivity: "personal" as const,
    sequence: 1,
    sessionId,
    source: {
      deviceId: randomUUID(),
      modality: "accessibility" as const,
    },
  };
}

function imageContextEnvelope(
  sessionId: string,
  capturedAt: Date,
  focusPoint: { readonly x: number; readonly y: number },
) {
  const bytes = Buffer.from("synthetic-image");
  return {
    authorization: {
      controlledSensitiveAllowed: false,
      grantId: randomUUID(),
      mode: "explicit" as const,
      purpose: "conversation" as const,
      retention: "ephemeral" as const,
    },
    capturedAt: capturedAt.toISOString(),
    completeness: 1,
    confidence: 1,
    eventId: randomUUID(),
    expiresAt: new Date(capturedAt.getTime() + 300_000).toISOString(),
    payload: {
      focusPoint,
      image: {
        data: bytes.toString("base64"),
        height: 100,
        mediaType: "image/jpeg" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: 200,
      },
      type: "screen.snapshot" as const,
    },
    protocolVersion: "1" as const,
    redactions: [],
    sensitivity: "personal" as const,
    sequence: 1,
    sessionId,
    source: {
      deviceId: randomUUID(),
      modality: "screen" as const,
    },
  };
}

function createContextService(): ContextService {
  return new ContextService({
    artifactStore: new InMemoryContextArtifactStore(),
    repository: new InMemoryContextSessionRepository(),
    understanding: new DeterministicContextUnderstandingPort(),
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function take<T>(events: AsyncIterable<T>, count: number): Promise<T[]> {
  const collected = [];
  for await (const event of events) {
    collected.push(event);
    if (collected.length === count) {
      break;
    }
  }
  return collected;
}
