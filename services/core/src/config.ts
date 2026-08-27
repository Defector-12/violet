import { readFileSync } from "node:fs";

export interface CoreRuntimeConfig {
  readonly contextStorage:
    | {
        readonly provider: "memory";
      }
    | {
        readonly accessKeyId: string;
        readonly bucket: string;
        readonly endpoint: string;
        readonly forcePathStyle: boolean;
        readonly prefix: string;
        readonly provider: "tos";
        readonly region: string;
        readonly secretAccessKey: string;
      };
  readonly contentKey: Buffer | null;
  readonly contentKeyVersion: string;
  readonly databaseUrl: string | undefined;
  readonly deviceTokenExpiresAt: Date;
  readonly deviceTokenHash: string;
  readonly host: string;
  readonly model:
    | {
        readonly provider: "deterministic";
      }
    | {
        readonly apiKey: string;
        readonly baseUrl: string;
        readonly model: string;
        readonly provider: "deepseek";
        readonly userId: string;
      };
  readonly port: number;
  readonly realtime:
    | {
        readonly provider: "deterministic";
      }
    | {
        readonly apiKey: string;
        readonly asrModel: string;
        readonly provider: "pipeline";
        readonly ttsModel: string;
        readonly voice: string;
        readonly workspaceId: string;
      }
    | {
        readonly apiKey: string;
        readonly model: string;
        readonly provider: "qwen-audio";
        readonly voice: string;
        readonly workspaceId: string;
      };
  readonly vision:
    | {
        readonly provider: "deterministic";
      }
    | {
        readonly apiKey: string;
        readonly baseUrl: string;
        readonly model: string;
        readonly provider: "deepseek";
      };
  readonly version: string;
}

export function loadCoreRuntimeConfig(env: NodeJS.ProcessEnv): CoreRuntimeConfig {
  const deviceTokenHash =
    env["VIOLET_DEVICE_TOKEN_SHA256"]?.trim() ??
    readSecretFile(required(env, "VIOLET_DEVICE_TOKEN_SHA256_FILE"), "device token hash");
  const deviceTokenExpiresAt = parseTimestamp(
    env["VIOLET_DEVICE_TOKEN_EXPIRES_AT"]?.trim() ??
      readSecretFile(
        required(env, "VIOLET_DEVICE_TOKEN_EXPIRES_AT_FILE"),
        "device token expiration",
      ),
    "device token expiration",
  );
  const contentKeyFile = env["VIOLET_CONTENT_KEY_FILE"];
  const contentKey = contentKeyFile ? loadContentKeyFile(contentKeyFile) : null;
  const databaseUrl =
    env["VIOLET_DATABASE_URL"]?.trim() ?? readOptionalSecretFile(env["VIOLET_DATABASE_URL_FILE"]);
  if (contentKey && !databaseUrl) {
    throw new Error("VIOLET_DATABASE_URL is required when Core is unsealed");
  }

  const model = loadModelConfig(env, contentKey !== null);
  const realtime = loadRealtimeConfig(env, contentKey !== null);
  const vision = loadVisionConfig(env, contentKey !== null);
  const contextStorage = loadContextStorageConfig(env, contentKey !== null);
  if (realtime.provider === "pipeline" && model.provider !== "deepseek") {
    throw new Error("The realtime pipeline requires the DeepSeek model provider");
  }

  return {
    contextStorage,
    contentKey,
    contentKeyVersion: env["VIOLET_CONTENT_KEY_VERSION"] ?? "content-v1",
    databaseUrl,
    deviceTokenExpiresAt,
    deviceTokenHash,
    host: env["VIOLET_HOST"] ?? "127.0.0.1",
    model,
    port: parsePort(env["VIOLET_PORT"] ?? "4310"),
    realtime,
    vision,
    version: env["VIOLET_VERSION"] ?? "0.1.0-dev",
  };
}

function loadContextStorageConfig(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): CoreRuntimeConfig["contextStorage"] {
  if (!enabled) {
    return { provider: "memory" };
  }
  const provider = env["VIOLET_CONTEXT_STORAGE_PROVIDER"] ?? "memory";
  if (provider === "memory") {
    return { provider };
  }
  if (provider !== "tos") {
    throw new Error("VIOLET_CONTEXT_STORAGE_PROVIDER must be memory or tos");
  }
  return {
    accessKeyId: readSecretFile(required(env, "TOS_ACCESS_KEY_ID_FILE"), "TOS access key ID"),
    bucket: required(env, "TOS_BUCKET"),
    endpoint: required(env, "TOS_ENDPOINT"),
    forcePathStyle: parseBoolean(env["TOS_FORCE_PATH_STYLE"] ?? "false"),
    prefix: env["VIOLET_CONTEXT_TOS_PREFIX"] ?? "violet/tmp/context",
    provider,
    region: required(env, "TOS_REGION"),
    secretAccessKey: readSecretFile(
      required(env, "TOS_SECRET_ACCESS_KEY_FILE"),
      "TOS secret access key",
    ),
  };
}

function loadModelConfig(env: NodeJS.ProcessEnv, enabled: boolean): CoreRuntimeConfig["model"] {
  if (!enabled) {
    return { provider: "deterministic" };
  }
  const provider = env["VIOLET_MODEL_PROVIDER"] ?? "deterministic";
  if (provider === "deterministic") {
    return { provider };
  }
  if (provider !== "deepseek") {
    throw new Error("VIOLET_MODEL_PROVIDER must be deterministic or deepseek");
  }

  const keyFile = required(env, "VIOLET_MODEL_API_KEY_FILE");
  return {
    apiKey: readSecretFile(keyFile, "model API key"),
    baseUrl: env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com",
    model: env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash",
    provider,
    userId: env["DEEPSEEK_USER_ID"] ?? "violet-instance",
  };
}

function loadRealtimeConfig(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): CoreRuntimeConfig["realtime"] {
  if (!enabled) {
    return { provider: "deterministic" };
  }
  const provider = env["VIOLET_REALTIME_PROVIDER"] ?? "deterministic";
  if (provider === "deterministic") {
    return { provider };
  }
  if (provider !== "pipeline" && provider !== "qwen-audio") {
    throw new Error("VIOLET_REALTIME_PROVIDER must be deterministic, pipeline, or qwen-audio");
  }

  const apiKey = readSecretFile(
    requiredOneOf(env, "DASHSCOPE_API_KEY_FILE", "QWEN_REALTIME_API_KEY_FILE"),
    "DashScope API key",
  );
  const workspaceId = requiredOneOf(env, "DASHSCOPE_WORKSPACE_ID", "QWEN_REALTIME_WORKSPACE_ID");
  if (provider === "pipeline") {
    return {
      apiKey,
      asrModel: env["PIPELINE_ASR_MODEL"] ?? "paraformer-realtime-v2",
      provider,
      ttsModel: env["PIPELINE_TTS_MODEL"] ?? "cosyvoice-v3-flash",
      voice: env["PIPELINE_TTS_VOICE"] ?? "longanyang",
      workspaceId,
    };
  }
  return {
    apiKey,
    model: env["QWEN_REALTIME_MODEL"] ?? "qwen-audio-3.0-realtime-plus",
    provider,
    voice: env["QWEN_REALTIME_VOICE"] ?? "longanqian",
    workspaceId,
  };
}

function loadVisionConfig(env: NodeJS.ProcessEnv, enabled: boolean): CoreRuntimeConfig["vision"] {
  if (!enabled) {
    return { provider: "deterministic" };
  }
  const provider = env["VIOLET_VISION_PROVIDER"] ?? "deterministic";
  if (provider === "deterministic") {
    return { provider };
  }
  if (provider !== "deepseek") {
    throw new Error("VIOLET_VISION_PROVIDER must be deterministic or deepseek");
  }

  return {
    apiKey: readSecretFile(
      requiredOneOf(env, "VIOLET_VISION_API_KEY_FILE", "VIOLET_MODEL_API_KEY_FILE"),
      "vision API key",
    ),
    baseUrl: env["DEEPSEEK_VISION_BASE_URL"] ?? "https://api.deepseek.com",
    model: env["DEEPSEEK_VISION_MODEL"] ?? "deepseek-v4-flash-vision-exp",
    provider,
  };
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("VIOLET_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseBoolean(value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("Boolean configuration must be true or false");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredOneOf(env: NodeJS.ProcessEnv, primary: string, fallback: string): string {
  const value = env[primary]?.trim() ?? env[fallback]?.trim();
  if (!value) {
    throw new Error(`${primary} or ${fallback} is required`);
  }
  return value;
}

function loadContentKeyFile(path: string): Buffer {
  const encoded = readFileSync(path, "utf8").trim();
  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error("content key file must contain exactly 32 base64-encoded bytes");
  }
  return key;
}

function readSecretFile(path: string, label: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!value) {
    throw new Error(`${label} file must not be empty`);
  }
  return value;
}

function readOptionalSecretFile(path: string | undefined): string | undefined {
  return path ? readSecretFile(path, "database URL") : undefined;
}

function parseTimestamp(value: string, label: string): Date {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return timestamp;
}
