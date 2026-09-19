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
import { ContextAssembler } from "./conversation/context-assembler.js";
import { ContextEpochManager } from "./conversation/context-epoch-manager.js";
import { InMemoryContextCheckpointRepository } from "./conversation/in-memory-context-checkpoint-repository.js";
import { InMemoryConversationLedger } from "./conversation/in-memory-conversation-ledger.js";
import { createPipelineContextAssembler } from "./conversation/pipeline-context.js";
import { buildCoreApp } from "./http/app.js";
import { DeepSeekModelGateway } from "./model/deepseek-model-gateway.js";
import { DeterministicModelGateway } from "./model/deterministic-model-gateway.js";
import { ModelConversationEndIntent } from "./realtime/conversation-end-intent.js";
import { DeterministicRealtimeConversationPort } from "./realtime/deterministic-realtime-conversation.js";
import { PipelineRealtimeConversationPort } from "./realtime/pipeline-realtime-conversation.js";
import { QwenAudioRealtimeConversationPort } from "./realtime/qwen-audio-realtime-conversation.js";
import { RealtimeTurnFailureRecovery } from "./realtime/realtime-turn-failure-recovery.js";
import { TestTraceStore } from "./realtime/test-trace.js";
import { PostgresContextCheckpointRepository } from "./storage/postgres-context-checkpoint-repository.js";
import { PostgresConversationLedger } from "./storage/postgres-conversation-ledger.js";

const coreAdvisoryLock = [0x5649_4f4c, 0x4554_434f];
const config = loadCoreRuntimeConfig(process.env);
const testTraceDirectory = process.env["VIOLET_TEST_TRACE_DIR"]?.trim();
const testTraces = testTraceDirectory ? new TestTraceStore(testTraceDirectory) : undefined;
const traceCleanup = testTraces ? setInterval(() => testTraces.purgeExpired(), 60_000) : undefined;
traceCleanup?.unref();
const pool =
  config.contentKey && config.databaseUrl
    ? new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        max: 10,
        query_timeout: 30_000,
      })
    : null;
const leasePool =
  config.contentKey && config.databaseUrl
    ? new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 10_000,
        max: 1,
      })
    : null;
const cipher = config.contentKey
  ? new EnvelopeCipher({
      key: config.contentKey,
      keyVersion: config.contentKeyVersion,
    })
  : null;
const coreLease = leasePool ? await leasePool.connect() : null;
if (coreLease) {
  const lease = await coreLease.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    coreAdvisoryLock,
  );
  if (lease.rows[0]?.acquired !== true) {
    coreLease.release();
    await Promise.all([leasePool?.end(), pool?.end()]);
    throw new Error("Another Violet Core process already owns the database lease");
  }
}
const ledger =
  pool && cipher
    ? new PostgresConversationLedger({
        cipher,
        constitutionVersion: "2026-08-18",
        instanceId: randomUUID(),
        pool,
      })
    : new InMemoryConversationLedger();
await ledger.recoverIncompleteRequests(new Date());
const realtimeFailureRecovery = new RealtimeTurnFailureRecovery({ ledger });
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
const checkpoints =
  pool && cipher
    ? new PostgresContextCheckpointRepository({ cipher, pool })
    : new InMemoryContextCheckpointRepository();
const contextEpochManager = new ContextEpochManager({ generateId: randomUUID });
const contextAssembler = new ContextAssembler({
  checkpointEnabled: config.contextCheckpointEnabled,
  checkpoints,
  ledger,
  model: modelGateway,
});
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
          assembleContext: createPipelineContextAssembler({
            contextAssembler,
            epochManager: contextEpochManager,
            generateId: randomUUID,
            ledger,
          }),
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
    contextAssembler,
    epochManager: contextEpochManager,
    generateId: randomUUID,
    ledger,
    modelGateway,
    turnFailureRecovery: realtimeFailureRecovery,
  }),
  conversationEndIntent: new ModelConversationEndIntent(modelGateway),
  contextAssembler,
  contextEpochManager,
  contextService,
  realtimeConversationPort,
  realtimeFailureRecovery,
  realtimeLedger: ledger,
  sealed: !config.contentKey,
  version: config.version,
  ...(testTraces ? { testTraces } : {}),
});
await app.listen({
  host: config.host,
  port: config.port,
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  let failure: unknown;
  try {
    await app.close();
  } catch (error) {
    failure = error;
  }
  if (traceCleanup) clearInterval(traceCleanup);
  try {
    await realtimeFailureRecovery.stop();
  } catch (error) {
    failure ??= error;
  }
  try {
    await pool?.end();
  } catch (error) {
    failure ??= error;
  }
  if (coreLease) {
    try {
      await coreLease.query("SELECT pg_advisory_unlock($1, $2)", coreAdvisoryLock);
    } catch (error) {
      failure ??= error;
    }
    coreLease.release();
  }
  try {
    await leasePool?.end();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
};
const handleShutdownSignal = () => {
  void shutdown().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`Violet shutdown failed: ${message}\n`);
    process.exitCode = 1;
  });
};
process.once("SIGINT", handleShutdownSignal);
process.once("SIGTERM", handleShutdownSignal);
