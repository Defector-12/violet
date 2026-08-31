import { randomUUID } from "node:crypto";
import { EnvelopeCipher } from "@violet/crypto";
import type { ModelGateway, RealtimeConversationPort } from "@violet/domain";
import { Pool } from "pg";

import { DeviceAuthenticator } from "./auth/device-authenticator.js";
import { loadCoreRuntimeConfig } from "./config.js";
import { ContextService } from "./context/context-service.js";
import { DeepSeekVisionUnderstandingPort } from "./context/deepseek-vision-understanding.js";
import { DeterministicContextUnderstandingPort } from "./context/deterministic-context-understanding.js";
import { InMemoryContextArtifactStore } from "./context/in-memory-context-artifact-store.js";
import { InMemoryContextSessionRepository } from "./context/in-memory-context-session-repository.js";
import { TosContextArtifactStore } from "./context/tos-context-artifact-store.js";
import { ChatService } from "./conversation/chat-service.js";
import { InMemoryConversationLedger } from "./conversation/in-memory-conversation-ledger.js";
import { buildCoreApp } from "./http/app.js";
import { DeepSeekModelGateway } from "./model/deepseek-model-gateway.js";
import { DeterministicModelGateway } from "./model/deterministic-model-gateway.js";
import { ModelConversationEndIntent } from "./realtime/conversation-end-intent.js";
import { DeterministicRealtimeConversationPort } from "./realtime/deterministic-realtime-conversation.js";
import { PipelineRealtimeConversationPort } from "./realtime/pipeline-realtime-conversation.js";
import { QwenAudioRealtimeConversationPort } from "./realtime/qwen-audio-realtime-conversation.js";
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
const realtimeModelGateway: ModelGateway =
  config.realtime.provider === "pipeline" && config.model.provider === "deepseek"
    ? new DeepSeekModelGateway({
        apiKey: config.model.apiKey,
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        thinking: false,
        userId: `${config.model.userId}-realtime`,
      })
    : modelGateway;
const realtimeConversationPort: RealtimeConversationPort =
  config.realtime.provider === "qwen-audio"
    ? new QwenAudioRealtimeConversationPort({
        apiKey: config.realtime.apiKey,
        generateId: randomUUID,
        model: config.realtime.model,
        voice: config.realtime.voice,
        workspaceId: config.realtime.workspaceId,
      })
    : config.realtime.provider === "pipeline"
      ? new PipelineRealtimeConversationPort({
          apiKey: config.realtime.apiKey,
          asrModel: config.realtime.asrModel,
          generateId: randomUUID,
          modelGateway: realtimeModelGateway,
          ttsModel: config.realtime.ttsModel,
          voice: config.realtime.voice,
          workspaceId: config.realtime.workspaceId,
        })
      : new DeterministicRealtimeConversationPort({
          generateId: randomUUID,
        });
const contextArtifactStore =
  config.contextStorage.provider === "tos" && config.contentKey
    ? new TosContextArtifactStore({
        accessKeyId: config.contextStorage.accessKeyId,
        bucket: config.contextStorage.bucket,
        cipher: new EnvelopeCipher({
          key: config.contentKey,
          keyVersion: config.contentKeyVersion,
        }),
        endpoint: config.contextStorage.endpoint,
        forcePathStyle: config.contextStorage.forcePathStyle,
        prefix: config.contextStorage.prefix,
        region: config.contextStorage.region,
        secretAccessKey: config.contextStorage.secretAccessKey,
      })
    : new InMemoryContextArtifactStore();
const contextService = new ContextService({
  artifactStore: contextArtifactStore,
  repository: new InMemoryContextSessionRepository(),
  understanding:
    config.vision.provider === "deepseek"
      ? new DeepSeekVisionUnderstandingPort({
          apiKey: config.vision.apiKey,
          baseUrl: config.vision.baseUrl,
          model: config.vision.model,
        })
      : new DeterministicContextUnderstandingPort(),
});
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
  conversationEndIntent: new ModelConversationEndIntent(modelGateway),
  contextService,
  realtimeConversationPort,
  realtimeLedger: ledger,
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
