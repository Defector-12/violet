import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readDeviceToken(env: NodeJS.ProcessEnv): Promise<string> {
  const injected = env["VIOLET_DEVICE_TOKEN"]?.trim();
  if (injected) {
    return injected;
  }

  if (process.platform !== "darwin") {
    throw new Error("VIOLET_DEVICE_TOKEN is required outside macOS");
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-a",
      "violet",
      "-s",
      "com.violet.device-token",
      "-w",
    ]);
    const token = stdout.trim();
    if (!token) {
      throw new Error("device token is empty");
    }
    return token;
  } catch {
    throw new Error("Device token is not available in Keychain under com.violet.device-token");
  }
}
