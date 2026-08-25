import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadCoreRuntimeConfig } from "./config.js";

const tokenHash = "a".repeat(64);
const tokenExpiresAt = "2100-01-01T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("loadCoreRuntimeConfig", () => {
  it("starts sealed without database or model credentials", () => {
    const config = loadCoreRuntimeConfig({
      VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
      VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      VIOLET_MODEL_PROVIDER: "deepseek",
    });

    expect(config.contentKey).toBeNull();
    expect(config.model.provider).toBe("deterministic");
    expect(config.realtime.provider).toBe("deterministic");
    expect(config.vision.provider).toBe("deterministic");
  });

  it("requires a database when the content key is loaded", () => {
    const contentKeyFile = writeSecretFile(Buffer.alloc(32, 1).toString("base64"));

    expect(() =>
      loadCoreRuntimeConfig({
        VIOLET_CONTENT_KEY_FILE: contentKeyFile,
        VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
        VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      }),
    ).toThrow("VIOLET_DATABASE_URL");
  });

  it("rejects a non-canonical device token expiration", () => {
    expect(() =>
      loadCoreRuntimeConfig({
        VIOLET_DEVICE_TOKEN_EXPIRES_AT: "2100-01-01",
        VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      }),
    ).toThrow("ISO 8601 UTC timestamp");
  });

  it("loads DeepSeek only after unsealing", () => {
    const contentKeyFile = writeSecretFile(Buffer.alloc(32, 1).toString("base64"));
    const modelKeyFile = writeSecretFile("test-model-key");
    const config = loadCoreRuntimeConfig({
      VIOLET_CONTENT_KEY_FILE: contentKeyFile,
      VIOLET_DATABASE_URL: "postgresql://violet:test@localhost/violet",
      VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
      VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      VIOLET_MODEL_API_KEY_FILE: modelKeyFile,
      VIOLET_MODEL_PROVIDER: "deepseek",
    });

    expect(config.contentKey).toHaveLength(32);
    expect(config.model).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
  });

  it("loads Qwen realtime credentials only after unsealing", () => {
    const contentKeyFile = writeSecretFile(Buffer.alloc(32, 1).toString("base64"));
    const realtimeKeyFile = writeSecretFile("test-qwen-realtime-key");
    const config = loadCoreRuntimeConfig({
      QWEN_REALTIME_API_KEY_FILE: realtimeKeyFile,
      QWEN_REALTIME_WORKSPACE_ID: "ws-testworkspace",
      VIOLET_CONTENT_KEY_FILE: contentKeyFile,
      VIOLET_DATABASE_URL: "postgresql://violet:test@localhost/violet",
      VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
      VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      VIOLET_REALTIME_PROVIDER: "qwen-audio",
    });

    expect(config.realtime).toEqual({
      apiKey: "test-qwen-realtime-key",
      model: "qwen-audio-3.0-realtime-plus",
      provider: "qwen-audio",
      voice: "longanqian",
      workspaceId: "ws-testworkspace",
    });
  });

  it("loads DeepSeek vision through the existing secret boundary", () => {
    const contentKeyFile = writeSecretFile(Buffer.alloc(32, 1).toString("base64"));
    const modelKeyFile = writeSecretFile("test-deepseek-key");
    const config = loadCoreRuntimeConfig({
      VIOLET_CONTENT_KEY_FILE: contentKeyFile,
      VIOLET_DATABASE_URL: "postgresql://violet:test@localhost/violet",
      VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
      VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      VIOLET_MODEL_API_KEY_FILE: modelKeyFile,
      VIOLET_VISION_PROVIDER: "deepseek",
    });

    expect(config.vision).toEqual({
      apiKey: "test-deepseek-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash-vision-exp",
      provider: "deepseek",
    });
  });

  it("loads ephemeral TOS context storage only after unsealing", () => {
    const contentKeyFile = writeSecretFile(Buffer.alloc(32, 1).toString("base64"));
    const accessKeyFile = writeSecretFile("test-access-key");
    const secretKeyFile = writeSecretFile("test-secret-key");
    const config = loadCoreRuntimeConfig({
      TOS_ACCESS_KEY_ID_FILE: accessKeyFile,
      TOS_BUCKET: "vio",
      TOS_ENDPOINT: "https://tos-s3-cn-beijing.volces.com",
      TOS_REGION: "cn-beijing",
      TOS_SECRET_ACCESS_KEY_FILE: secretKeyFile,
      VIOLET_CONTENT_KEY_FILE: contentKeyFile,
      VIOLET_CONTEXT_STORAGE_PROVIDER: "tos",
      VIOLET_DATABASE_URL: "postgresql://violet:test@localhost/violet",
      VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
      VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
    });

    expect(config.contextStorage).toEqual({
      accessKeyId: "test-access-key",
      bucket: "vio",
      endpoint: "https://tos-s3-cn-beijing.volces.com",
      forcePathStyle: false,
      prefix: "violet/tmp/context",
      provider: "tos",
      region: "cn-beijing",
      secretAccessKey: "test-secret-key",
    });
  });

  it("loads the realtime pipeline with Paraformer, DeepSeek, and CosyVoice", () => {
    const contentKeyFile = writeSecretFile(Buffer.alloc(32, 1).toString("base64"));
    const dashScopeKeyFile = writeSecretFile("test-dashscope-key");
    const modelKeyFile = writeSecretFile("test-deepseek-key");
    const config = loadCoreRuntimeConfig({
      DASHSCOPE_API_KEY_FILE: dashScopeKeyFile,
      DASHSCOPE_WORKSPACE_ID: "ws-testworkspace",
      VIOLET_CONTENT_KEY_FILE: contentKeyFile,
      VIOLET_DATABASE_URL: "postgresql://violet:test@localhost/violet",
      VIOLET_DEVICE_TOKEN_EXPIRES_AT: tokenExpiresAt,
      VIOLET_DEVICE_TOKEN_SHA256: tokenHash,
      VIOLET_MODEL_API_KEY_FILE: modelKeyFile,
      VIOLET_MODEL_PROVIDER: "deepseek",
      VIOLET_REALTIME_PROVIDER: "pipeline",
    });

    expect(config.realtime).toEqual({
      apiKey: "test-dashscope-key",
      asrModel: "paraformer-realtime-v2",
      provider: "pipeline",
      ttsModel: "cosyvoice-v3-flash",
      voice: "longanyang",
      workspaceId: "ws-testworkspace",
    });
  });
});

function writeSecretFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "violet-config-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "secret");
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}
