import { randomUUID } from "node:crypto";
import { EnvelopeCipher } from "@violet/crypto";
import type { ModelGateway } from "@violet/domain";
import { Pool } from "pg";

import { DeviceAuthenticator } from "./auth/device-authenticator.js";
import { loadCoreRuntimeConfig } from "./config.js";
import { ChatService } from "./conversation/chat-service.js";
import { InMemoryConversationLedger } from "./conversation/in-memory-conversation-ledger.js";
import { buildCoreApp } from "./http/app.js";
import { DeepSeekModelGateway } from "./model/deepseek-model-gateway.js";
import { DeterministicModelGateway } from "./model/deterministic-model-gateway.js";
import { PostgresConversationLedger } from "./storage/postgres-conversation-ledger.js";

const config = loadCoreRuntimeConfig(process.env);
const pool =
  config.contentKey && config.databaseUrl
    ? new Pool({
        connectionString: config.databaseUrl,
        max: 10,
      })
    : null;
const ledger =
  pool && config.contentKey
    ? new PostgresConversationLedger({
        cipher: new EnvelopeCipher({
          key: config.contentKey,
          keyVersion: config.contentKeyVersion,
        }),
        constitutionVersion: "2026-08-18",
        instanceId: randomUUID(),
        pool,
      })
    : new InMemoryConversationLedger();
const modelGateway: ModelGateway =
  config.model.provider === "deepseek"
    ? new DeepSeekModelGateway({
        apiKey: config.model.apiKey,
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        userId: config.model.userId,
      })
    : new DeterministicModelGateway();
const app = buildCoreApp({
  authenticator: new DeviceAuthenticator({
    expectedHashHex: config.deviceTokenHash,
    expiresAt: config.deviceTokenExpiresAt,
  }),
  chatService: new ChatService({
    generateId: randomUUID,
    ledger,
    modelGateway,
  }),
  sealed: !config.contentKey,
  version: config.version,
});
app.addHook("onClose", async () => {
  await pool?.end();
});

await app.listen({
  host: config.host,
  port: config.port,
});

const shutdown = async () => {
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
