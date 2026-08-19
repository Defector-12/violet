import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: pnpm env:inject-devbox <user@host>");
}

const env = parseEnv(await readFile(".env", "utf8"));
const databasePassword = required(env, "VIOLET_DATABASE_PASSWORD");
const secrets = {
  content_key: required(env, "VIOLET_CONTENT_KEY"),
  database_url: `postgresql://violet:${encodeURIComponent(databasePassword)}@postgres:5432/violet`,
  deepseek_api_key: required(env, "DEEPSEEK_API_KEY"),
  device_token_sha256: createHash("sha256")
    .update(required(env, "VIOLET_DEVICE_TOKEN"), "utf8")
    .digest("hex"),
  grafana_admin_password: required(env, "VIOLET_GRAFANA_ADMIN_PASSWORD"),
  postgres_password: databasePassword,
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
    const child = spawn(
      "ssh",
      [
        targetHost,
        `umask 077; mkdir -p /dev/shm/violet; chmod 700 /dev/shm/violet; cat > /dev/shm/violet/${name}; chmod 0444 /dev/shm/violet/${name}`,
      ],
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
