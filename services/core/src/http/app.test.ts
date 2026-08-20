import { randomUUID } from "node:crypto";
import type { RealtimeServerEvent } from "@violet/protocol";
import { VioletClient } from "@violet/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { RawData, WebSocket } from "ws";

import { DeviceAuthenticator, hashDeviceToken } from "../auth/device-authenticator.js";
import { ChatService } from "../conversation/chat-service.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { DeterministicModelGateway } from "../model/deterministic-model-gateway.js";
import { DeterministicRealtimeConversationPort } from "../realtime/deterministic-realtime-conversation.js";
import { buildCoreApp } from "./app.js";

const deviceToken = "test-device-token-that-is-at-least-32-characters";
const openApps: Array<ReturnType<typeof buildCoreApp>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Core HTTP API", () => {
  it("exposes liveness without authentication", async () => {
    const { client } = await startCore(false);

    await expect(client.getHealth()).resolves.toMatchObject({
      service: "violet-core",
      status: "ok",
    });
  });

  it("rejects status requests without a device token", async () => {
    const { baseUrl } = await startCore(false);
    const client = new VioletClient({ baseUrl });

    await expect(client.getStatus()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("rejects content access while sealed", async () => {
    const { client } = await startCore(true);
    const consume = async () => {
      for await (const _event of client.streamChat({
        message: "Hello",
        requestId: randomUUID(),
      })) {
        // Consume the stream to surface request errors.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "CORE_SEALED",
      status: 423,
    });
  });

  it("streams a deterministic response when ready", async () => {
    const { client } = await startCore(false);
    const requestId = randomUUID();
    const events = [];

    for await (const event of client.streamChat({ message: "Hello", requestId })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "complete"]);
    expect(events[1]).toMatchObject({
      content: "Violet test response: Hello",
      requestId,
      type: "delta",
    });
  });

  it("rejects realtime upgrades without authentication or while sealed", async () => {
    const ready = await startCore(false);
    const sealed = await startCore(true);

    await expect(ready.app.injectWS("/v1/realtime")).rejects.toThrow(
      "Unexpected server response: 401",
    );
    await expect(
      sealed.app.injectWS("/v1/realtime", {
        headers: { authorization: `Bearer ${deviceToken}` },
      }),
    ).rejects.toThrow("Unexpected server response: 423");
  });

  it("runs a deterministic provider-neutral realtime session", async () => {
    const { app } = await startCore(false);
    const socket = await app.injectWS("/v1/realtime", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const sessionId = randomUUID();
    const turnId = randomUUID();

    const readyEvents = receiveEvents(socket, 1);
    socket.send(
      JSON.stringify({
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
    await expect(readyEvents).resolves.toMatchObject([
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

    const responseEvents = receiveEvents(socket, 3);
    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        sequence: 2,
        sessionId,
        text: "Hello",
        turnId,
        type: "input.text",
      }),
    );
    const response = await responseEvents;

    expect(response.map((event) => event.type)).toEqual([
      "response.started",
      "response.text",
      "response.completed",
    ]);
    expect(response[1]).toMatchObject({
      text: "Violet realtime test response: Hello",
      turnId,
      type: "response.text",
    });
    socket.terminate();
  });

  it("closes a realtime connection on unknown protocol events", async () => {
    const { app } = await startCore(false);
    const socket = await app.injectWS("/v1/realtime", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    socket.send(
      JSON.stringify({
        eventId: randomUUID(),
        sequence: 1,
        sessionId: randomUUID(),
        type: "provider.magic",
      }),
    );

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: "INVALID_REALTIME_EVENT",
    });
  });
});

async function startCore(sealed: boolean): Promise<{
  readonly app: ReturnType<typeof buildCoreApp>;
  readonly baseUrl: string;
  readonly client: VioletClient;
}> {
  const ledger = new InMemoryConversationLedger();
  const app = buildCoreApp({
    authenticator: new DeviceAuthenticator({
      expectedHashHex: hashDeviceToken(deviceToken),
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    }),
    chatService: new ChatService({
      generateId: randomUUID,
      ledger,
      modelGateway: new DeterministicModelGateway(),
    }),
    realtimeConversationPort: new DeterministicRealtimeConversationPort({
      generateId: randomUUID,
    }),
    realtimeLedger: ledger,
    sealed,
    version: "test",
  });
  openApps.push(app);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    app,
    baseUrl,
    client: new VioletClient({ baseUrl, deviceToken }),
  };
}

function receiveEvents(socket: WebSocket, count: number): Promise<RealtimeServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: RealtimeServerEvent[] = [];
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      events.push(JSON.parse(data.toString()) as RealtimeServerEvent);
      if (events.length === count) {
        cleanup();
        resolve(events);
      }
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };

    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}
