import { readFileSync } from "node:fs";

export interface CoreRuntimeConfig {
  readonly contentKey: Buffer | null;
  readonly contentKeyVersion: string;
  readonly databaseUrl: string | undefined;
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
  readonly version: string;
}

export function loadCoreRuntimeConfig(env: NodeJS.ProcessEnv): CoreRuntimeConfig {
  const deviceTokenHash =
    env["VIOLET_DEVICE_TOKEN_SHA256"]?.trim() ??
    readSecretFile(required(env, "VIOLET_DEVICE_TOKEN_SHA256_FILE"), "device token hash");
  const contentKeyFile = env["VIOLET_CONTENT_KEY_FILE"];
  const contentKey = contentKeyFile ? loadContentKeyFile(contentKeyFile) : null;
  const databaseUrl =
    env["VIOLET_DATABASE_URL"]?.trim() ?? readOptionalSecretFile(env["VIOLET_DATABASE_URL_FILE"]);
  if (contentKey && !databaseUrl) {
    throw new Error("VIOLET_DATABASE_URL is required when Core is unsealed");
  }

  const model = loadModelConfig(env, contentKey !== null);

  return {
    contentKey,
    contentKeyVersion: env["VIOLET_CONTENT_KEY_VERSION"] ?? "content-v1",
    databaseUrl,
    deviceTokenHash,
    host: env["VIOLET_HOST"] ?? "127.0.0.1",
    model,
    port: parsePort(env["VIOLET_PORT"] ?? "4310"),
    version: env["VIOLET_VERSION"] ?? "0.1.0-dev",
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

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("VIOLET_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
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
