import { randomUUID } from "node:crypto";
import { VioletClient } from "@violet/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceAuthenticator, hashDeviceToken } from "../auth/device-authenticator.js";
import { ChatService } from "../conversation/chat-service.js";
import { InMemoryConversationLedger } from "../conversation/in-memory-conversation-ledger.js";
import { DeterministicModelGateway } from "../model/deterministic-model-gateway.js";
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
});

async function startCore(sealed: boolean): Promise<{
  readonly baseUrl: string;
  readonly client: VioletClient;
}> {
  const app = buildCoreApp({
    authenticator: new DeviceAuthenticator(hashDeviceToken(deviceToken)),
    chatService: new ChatService({
      generateId: randomUUID,
      ledger: new InMemoryConversationLedger(),
      modelGateway: new DeterministicModelGateway(),
    }),
    sealed,
    version: "test",
  });
  openApps.push(app);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    client: new VioletClient({ baseUrl, deviceToken }),
  };
}
