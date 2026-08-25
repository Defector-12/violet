import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { EnvelopeCipher } from "@violet/crypto";
import { describe, expect, it } from "vitest";

import { TosContextArtifactStore } from "./tos-context-artifact-store.js";

describe("TosContextArtifactStore", () => {
  it("stores only envelope-encrypted bytes and removes every object version", async () => {
    const commands: unknown[] = [];
    const client = {
      async send(command: unknown) {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          return {
            DeleteMarkers: [{ Key: "violet/tmp/context/session/event.vltctx", VersionId: "d1" }],
            IsTruncated: false,
            Versions: [{ Key: "violet/tmp/context/session/event.vltctx", VersionId: "v1" }],
          };
        }
        return {};
      },
    };
    const store = new TosContextArtifactStore({
      accessKeyId: "test-access",
      bucket: "vio",
      cipher: new EnvelopeCipher({
        key: randomBytes(32),
        keyVersion: "content-v1",
      }),
      client,
      endpoint: "https://tos-s3-cn-beijing.volces.com",
      region: "cn-beijing",
      secretAccessKey: "test-secret",
    });

    await store.put({
      bytes: Buffer.from("private screenshot"),
      eventId: "event",
      expiresAt: new Date("2026-08-25T00:00:00.000Z"),
      mediaType: "image/png",
      sessionId: "session",
      sha256: "a".repeat(64),
    });
    await store.deleteSession("session");

    const put = commands.find((command) => command instanceof PutObjectCommand);
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(String((put as PutObjectCommand).input.Body)).not.toContain("private screenshot");
    expect((put as PutObjectCommand).input).toMatchObject({
      Bucket: "vio",
      Key: "violet/tmp/context/session/event.vltctx",
      ServerSideEncryption: "AES256",
    });
    expect(commands.filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(2);
  });
});
