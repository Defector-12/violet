import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { EnvelopeCipher } from "@violet/crypto";
import type { ContextArtifactStore } from "@violet/domain";

interface ObjectStoreClient {
  send(command: unknown): Promise<unknown>;
}

export class TosContextArtifactStore implements ContextArtifactStore {
  readonly #bucket: string;
  readonly #cipher: EnvelopeCipher;
  readonly #client: ObjectStoreClient;
  readonly #prefix: string;

  constructor(input: {
    readonly accessKeyId: string;
    readonly bucket: string;
    readonly cipher: EnvelopeCipher;
    readonly client?: ObjectStoreClient;
    readonly endpoint: string;
    readonly forcePathStyle?: boolean;
    readonly prefix?: string;
    readonly region: string;
    readonly secretAccessKey: string;
  }) {
    this.#bucket = required(input.bucket, "TOS bucket");
    this.#cipher = input.cipher;
    this.#prefix = normalizePrefix(input.prefix ?? "violet/tmp/context");
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:") {
      throw new Error("TOS endpoint must use HTTPS");
    }
    this.#client =
      input.client ??
      new S3Client({
        credentials: {
          accessKeyId: required(input.accessKeyId, "TOS access key ID"),
          secretAccessKey: required(input.secretAccessKey, "TOS secret access key"),
        },
        endpoint: endpoint.toString(),
        forcePathStyle: input.forcePathStyle ?? false,
        region: required(input.region, "TOS region"),
      });
  }

  async put(input: Parameters<ContextArtifactStore["put"]>[0]): Promise<void> {
    const encrypted = this.#cipher.encrypt(input.bytes);
    const body = Buffer.from(
      JSON.stringify({
        algorithm: encrypted.algorithm,
        ciphertext: encrypted.ciphertext.toString("base64"),
        contentNonce: encrypted.contentNonce.toString("base64"),
        contentTag: encrypted.contentTag.toString("base64"),
        keyNonce: encrypted.keyNonce.toString("base64"),
        keyTag: encrypted.keyTag.toString("base64"),
        keyVersion: encrypted.keyVersion,
        wrappedKey: encrypted.wrappedKey.toString("base64"),
      }),
      "utf8",
    );
    await this.#client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: this.#bucket,
        ContentLength: body.byteLength,
        ContentType: "application/vnd.violet.context+json",
        Key: this.#objectKey(input.sessionId, input.eventId),
        Metadata: {
          "expires-at": input.expiresAt.toISOString(),
        },
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const prefix = `${this.#prefix}/${sessionId}/`;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    do {
      const response = (await this.#client.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          KeyMarker: keyMarker,
          Prefix: prefix,
          VersionIdMarker: versionIdMarker,
        }),
      )) as {
        readonly DeleteMarkers?: readonly {
          readonly Key?: string;
          readonly VersionId?: string;
        }[];
        readonly IsTruncated?: boolean;
        readonly NextKeyMarker?: string;
        readonly NextVersionIdMarker?: string;
        readonly Versions?: readonly {
          readonly Key?: string;
          readonly VersionId?: string;
        }[];
      };

      for (const object of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
        if (object.Key && object.VersionId) {
          await this.#client.send(
            new DeleteObjectCommand({
              Bucket: this.#bucket,
              Key: object.Key,
              VersionId: object.VersionId,
            }),
          );
        }
      }
      keyMarker = response.NextKeyMarker;
      versionIdMarker = response.NextVersionIdMarker;
      if (!response.IsTruncated) {
        break;
      }
    } while (keyMarker);
  }

  #objectKey(sessionId: string, eventId: string): string {
    return `${this.#prefix}/${sessionId}/${eventId}.vltctx`;
  }
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..")) {
    throw new Error("TOS context prefix is invalid");
  }
  return prefix;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}
