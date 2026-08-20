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
const dataDirectory = process.env.VIOLET_DEVBOX_DATA_DIR ?? "/data00/violet";
if (!/^\/[A-Za-z0-9._/-]+$/.test(dataDirectory) || dataDirectory.split("/").includes("..")) {
  throw new Error("VIOLET_DEVBOX_DATA_DIR must be an absolute path without parent traversal");
}

const env = parseEnv(await readFile(".env", "utf8"));
const databasePassword = required(env, "VIOLET_DATABASE_PASSWORD");
const configuration = {
  device_token_expires_at: required(env, "VIOLET_DEVICE_TOKEN_EXPIRES_AT"),
  device_token_sha256: createHash("sha256")
    .update(required(env, "VIOLET_DEVICE_TOKEN"), "utf8")
    .digest("hex"),
};
const secrets = {
  backup_public_key: required(env, "VIOLET_BACKUP_PUBLIC_KEY"),
  content_key: required(env, "VIOLET_CONTENT_KEY"),
  database_url: `postgresql://violet:${encodeURIComponent(databasePassword)}@postgres:5432/violet`,
  deepseek_api_key: required(env, "DEEPSEEK_API_KEY"),
  grafana_admin_password: required(env, "VIOLET_GRAFANA_ADMIN_PASSWORD"),
  postgres_password: databasePassword,
  ...(includeTos
    ? {
        tos_access_key_id: required(env, "TOS_ACCESS_KEY_ID"),
        tos_secret_access_key: required(env, "TOS_SECRET_ACCESS_KEY"),
      }
    : {}),
};

await ensureRemoteUserLinger(target);
await prepareRemoteDirectory(target, `${dataDirectory}/config`, "755", false);
await prepareRemoteDirectory(target, "/dev/shm/violet", "700", true);
for (const [name, value] of Object.entries(configuration)) {
  await writeRemoteFile(target, `${dataDirectory}/config`, "755", name, value);
}
for (const [name, value] of Object.entries(secrets)) {
  await writeRemoteFile(target, "/dev/shm/violet", "700", name, value);
}

process.stdout.write(
  `Injected ${Object.keys(configuration).join(", ")} into persistent non-secret configuration and ${Object.keys(secrets).join(", ")} into the Devbox memory filesystem.\n`,
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

function writeRemoteFile(targetHost, directory, directoryMode, name, value) {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("invalid remote secret name");
  }
  if (directoryMode !== "700" && directoryMode !== "755") {
    throw new Error("invalid remote directory mode");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      sshArguments(
        targetHost,
        `set -eu; umask 077; directory=${shellQuote(directory)}; mkdir -p "$directory"; chmod ${directoryMode} "$directory"; temporary=$(mktemp "$directory/${name}.XXXXXX"); trap 'rm -f "$temporary"' EXIT; cat > "$temporary"; chmod 0444 "$temporary"; mv -f "$temporary" "$directory/${name}"; trap - EXIT`,
      ),
      {
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
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

function prepareRemoteDirectory(targetHost, directory, directoryMode, removeChildDirectories) {
  const cleanup = removeChildDirectories
    ? 'for child in "$directory"/*; do if [ -d "$child" ]; then sudo -n rm -rf -- "$child"; fi; done'
    : ":";
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      sshArguments(
        targetHost,
        `set -eu; directory=${shellQuote(directory)}; sudo -n install -d -m ${directoryMode} -o "$(id -u)" -g "$(id -g)" "$directory"; ${cleanup}`,
      ),
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`failed to prepare ${directory}`));
      }
    });
  });
}

function ensureRemoteUserLinger(targetHost) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      sshArguments(
        targetHost,
        'set -eu; user=$(id -un); sudo -n loginctl enable-linger "$user"; test "$(loginctl show-user "$user" -p Linger --value)" = yes',
      ),
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("failed to enable remote user linger"));
      }
    });
  });
}

function sshArguments(targetHost, command) {
  const arguments_ = [];
  const knownHostsFile = process.env.VIOLET_DEVBOX_KNOWN_HOSTS_FILE;
  if (knownHostsFile) {
    arguments_.push(
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-o",
      "StrictHostKeyChecking=yes",
    );
  }
  arguments_.push(targetHost, command);
  return arguments_;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
