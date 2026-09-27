import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Keep the inode: both the Mac writer and this reader use BSD flock on this file.
export async function withRestoreLock<T>(
  instanceId: string,
  operation: () => Promise<T>,
  directory = join(homedir(), "Library/Application Support/Violet/restore-locks"),
): Promise<T> {
  if (process.platform !== "darwin" || !validInstance(instanceId)) {
    throw new Error("Official restore requires a valid Mac instance");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(
    join(directory, `${instanceId.toLowerCase()}.lock`),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // macOS lockf can lock an inherited descriptor. The parent retains that open
    // description after lockf exits, so the lock lives until our handle closes.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
        stdio: ["ignore", "ignore", "ignore", lock.fd],
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Restore protection is busy or unavailable; retry after it finishes")),
      );
    });
    return await operation();
  } finally {
    await lock.close();
  }
}

export async function loadRestorePolicy(instanceId: string) {
  if (process.platform !== "darwin") {
    throw new Error("Official restore requires the Mac device's Keychain");
  }
  if (!validInstance(instanceId)) throw new Error("Restore instance ID is invalid");
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "com.violet.restore-epoch",
        "-a",
        instanceId.toLowerCase(),
        "-w",
      ],
      { maxBuffer: 4096 },
    ));
  } catch {
    throw new Error("Keychain restore protection is missing or unavailable");
  }
  return parseRestorePolicy(stdout, instanceId);
}

export function parseRestorePolicy(
  json: string,
  instanceId: string,
): {
  readonly instanceId: string;
  readonly minimumRestoreEpoch: number;
} {
  const value = JSON.parse(json) as Record<string, unknown>;
  if (
    !validInstance(instanceId) ||
    !value ||
    value["instanceId"] !== instanceId.toLowerCase() ||
    typeof value["minimumRestoreEpoch"] !== "number" ||
    !Number.isSafeInteger(value["minimumRestoreEpoch"]) ||
    value["minimumRestoreEpoch"] < 0
  )
    throw new Error("Keychain restore protection is invalid");
  return {
    instanceId: instanceId.toLowerCase(),
    minimumRestoreEpoch: value["minimumRestoreEpoch"],
  };
}

function validInstance(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
