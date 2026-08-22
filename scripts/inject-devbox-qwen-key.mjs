import { spawn } from "node:child_process";

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  throw new Error("Usage: pnpm env:inject-devbox-qwen <user@host>");
}
if (!process.stdin.isTTY) {
  throw new Error("Qwen API key injection requires an interactive terminal");
}

const apiKey = await readHidden("Qwen realtime API key: ");
if (apiKey.length < 16 || /\s/.test(apiKey)) {
  throw new Error("Qwen API key is empty or malformed");
}

await ensureRemoteUserLinger(target);
await prepareRemoteDirectory(target);
await writeRemoteSecret(target, apiKey);
process.stdout.write("Injected qwen_realtime_api_key into the Devbox memory filesystem.\n");

async function readHidden(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  try {
    return await new Promise((resolve, reject) => {
      let value = "";
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("Qwen API key injection cancelled"));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolve(value.trim());
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1);
          } else {
            value += character;
          }
        }
      };
      const cleanup = () => {
        process.stdin.off("data", onData);
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function ensureRemoteUserLinger(targetHost) {
  return runSsh(
    targetHost,
    'set -eu; user=$(id -un); sudo -n loginctl enable-linger "$user"; test "$(loginctl show-user "$user" -p Linger --value)" = yes',
    "failed to enable remote user linger",
  );
}

function prepareRemoteDirectory(targetHost) {
  return runSsh(
    targetHost,
    'set -eu; directory=/dev/shm/violet; sudo -n install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$directory"',
    "failed to prepare the remote runtime secret directory",
  );
}

function writeRemoteSecret(targetHost, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      sshArguments(
        targetHost,
        'set -eu; umask 077; directory=/dev/shm/violet; temporary=$(mktemp "$directory/qwen_realtime_api_key.XXXXXX"); trap \'rm -f "$temporary"\' EXIT; cat > "$temporary"; chmod 0444 "$temporary"; mv -f "$temporary" "$directory/qwen_realtime_api_key"; trap - EXIT',
      ),
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    child.stdin.end(value);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("failed to inject qwen_realtime_api_key"));
      }
    });
  });
}

function runSsh(targetHost, command, errorMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArguments(targetHost, command), {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(errorMessage));
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
