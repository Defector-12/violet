#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { ChatStreamEvent } from "@violet/protocol";
import { VioletApiError, VioletClient } from "@violet/sdk";

import { readDeviceToken } from "./keychain.js";

const { positionals } = parseArgs({
  allowPositionals: true,
});
const [command = "help", ...arguments_] = positionals;
const baseUrl = process.env["VIOLET_CORE_URL"] ?? "http://127.0.0.1:4310";

try {
  if (command === "health") {
    const client = new VioletClient({ baseUrl });
    const health = await client.getHealth();
    stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  } else if (command === "status") {
    const client = await authenticatedClient(baseUrl);
    const status = await client.getStatus();
    stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else if (command === "ask") {
    const message = arguments_.join(" ").trim();
    if (!message) {
      throw new Error("Usage: violet ask <message>");
    }
    const client = await authenticatedClient(baseUrl);
    await printChat(client, message);
  } else if (command === "chat") {
    await interactiveChat(await authenticatedClient(baseUrl));
  } else {
    printHelp();
  }
} catch (error) {
  if (error instanceof VioletApiError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown error"}\n`);
  }
  process.exitCode = 1;
}

async function authenticatedClient(url: string): Promise<VioletClient> {
  return new VioletClient({
    baseUrl: url,
    deviceToken: await readDeviceToken(process.env),
  });
}

async function interactiveChat(client: VioletClient): Promise<void> {
  const readline = createInterface({ input: stdin, output: stdout });
  stdout.write("Violet text session. Submit an empty line to exit.\n");

  try {
    while (true) {
      const message = (await readline.question("> ")).trim();
      if (!message) {
        break;
      }
      await printChat(client, message);
    }
  } finally {
    readline.close();
  }
}

async function printChat(client: VioletClient, message: string): Promise<void> {
  let wroteContent = false;

  for await (const event of client.streamChat({
    message,
    requestId: randomUUID(),
  })) {
    wroteContent = renderEvent(event, wroteContent);
  }

  if (wroteContent) {
    stdout.write("\n");
  }
}

function renderEvent(event: ChatStreamEvent, wroteContent: boolean): boolean {
  if (event.type === "delta") {
    stdout.write(event.content);
    return true;
  }
  if (event.type === "error") {
    throw new VioletApiError(502, event.error);
  }
  return wroteContent;
}

function printHelp(): void {
  stdout.write(`Usage:
  violet health
  violet status
  violet ask <message>
  violet chat
`);
}
