import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: pnpm env:inject-devbox <user@host> [--include-tos]");
}
const includeTos = process.argv.slice(3).includes("--include-tos");
if (process.argv.slice(3).some((argument) => argument !== "--include-tos")) {
  throw new Error("Unknown argument");
}

const env = parseEnv(await readFile(".env", "utf8"));
const databasePassword = required(env, "VIOLET_DATABASE_PASSWORD");
const secrets = {
  backup_public_key: required(env, "VIOLET_BACKUP_PUBLIC_KEY"),
  content_key: required(env, "VIOLET_CONTENT_KEY"),
  database_url: `postgresql://violet:${encodeURIComponent(databasePassword)}@postgres:5432/violet`,
  deepseek_api_key: required(env, "DEEPSEEK_API_KEY"),
  device_token_expires_at: required(env, "VIOLET_DEVICE_TOKEN_EXPIRES_AT"),
  device_token_sha256: createHash("sha256")
    .update(required(env, "VIOLET_DEVICE_TOKEN"), "utf8")
    .digest("hex"),
  grafana_admin_password: required(env, "VIOLET_GRAFANA_ADMIN_PASSWORD"),
  postgres_password: databasePassword,
  ...(includeTos
    ? {
        tos_access_key_id: required(env, "TOS_ACCESS_KEY_ID"),
        tos_secret_access_key: required(env, "TOS_SECRET_ACCESS_KEY"),
      }
    : {}),
};

for (const [name, value] of Object.entries(secrets)) {
  await writeRemoteSecret(target, name, value);
}

process.stdout.write(
  `Injected ${Object.keys(secrets).join(", ")} into the Devbox memory filesystem.\n`,
);

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function required(values, name) {
  const value = values[name]?.trim();
  if (!value) {
    throw new Error(`${name} is missing from .env`);
  }
  return value;
}

function writeRemoteSecret(targetHost, name, value) {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("invalid remote secret name");
  }

  return new Promise((resolve, reject) => {
    const sshArguments = [];
    const knownHostsFile = process.env.VIOLET_DEVBOX_KNOWN_HOSTS_FILE;
    if (knownHostsFile) {
      sshArguments.push(
        "-o",
        `UserKnownHostsFile=${knownHostsFile}`,
        "-o",
        "StrictHostKeyChecking=yes",
      );
    }
    sshArguments.push(
      targetHost,
      `set -eu; umask 077; directory=/dev/shm/violet; mkdir -p "$directory"; chmod 700 "$directory"; temporary=$(mktemp "$directory/${name}.XXXXXX"); trap 'rm -f "$temporary"' EXIT; cat > "$temporary"; chmod 0444 "$temporary"; mv -f "$temporary" "$directory/${name}"; trap - EXIT`,
    );
    const child = spawn("ssh", sshArguments, {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.end(value);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`failed to inject ${name}`));
      }
    });
  });
}
