import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const envPath = resolve(".env");
const temporaryPath = `${envPath}.tmp`;
let content = await readFile(envPath, "utf8");

const generated = {
  VIOLET_CONTENT_KEY: randomBytes(32).toString("base64"),
  VIOLET_DATABASE_PASSWORD: randomBytes(32).toString("base64url"),
  VIOLET_DEVICE_TOKEN: randomBytes(32).toString("base64url"),
  VIOLET_GRAFANA_ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
};
const changed = [];

for (const [key, value] of Object.entries(generated)) {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = content.match(pattern);
  if (!match) {
    content = `${key}=${value}\n${content}`;
    changed.push(key);
  } else if (!match[1]?.trim()) {
    content = content.replace(pattern, `${key}=${value}`);
    changed.push(key);
  }
}

await writeFile(temporaryPath, content, { mode: 0o600 });
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);
process.stdout.write(
  changed.length > 0
    ? `Generated ${changed.join(", ")} without displaying their values.\n`
    : "Local Violet secrets already exist.\n",
);
