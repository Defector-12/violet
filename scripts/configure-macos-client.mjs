#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const host = process.argv
  .slice(2)
  .find((argument) => argument !== "--")
  ?.trim();
if (!host || !/^[A-Za-z0-9._-]+$/.test(host)) {
  throw new Error("Usage: configure-macos-client.mjs <ssh-host>");
}

const path = process.env["VIOLET_CLIENT_CONFIG"] ?? join(homedir(), ".config/violet/client.json");
mkdirSync(dirname(path), { mode: 0o700, recursive: true });
writeFileSync(
  path,
  `${JSON.stringify(
    {
      coreURL: "http://127.0.0.1:14310",
      excludedContextBundleIds: [],
      sshTunnel: {
        host,
        localPort: 14310,
        remoteHost: "127.0.0.1",
        remotePort: 4310,
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
chmodSync(path, 0o600);
process.stdout.write(`${path}\n`);
