/** One bounded metadata line emitted by the same transaction that exports pg_dump's snapshot. */
export async function readSnapshotStream(input: AsyncIterable<Uint8Array>): Promise<{
  readonly instanceId: string;
  readonly restoreEpoch: number;
  readonly dump: AsyncIterable<Uint8Array>;
}> {
  const iterator = input[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error("backup snapshot metadata is missing");
    prefix = Buffer.concat([prefix, next.value]);
    const newline = prefix.indexOf(10);
    if (newline < 0 && prefix.length <= 1024) continue;
    if (newline < 0 || newline > 1024) throw new Error("backup snapshot metadata is too large");
    const metadata = JSON.parse(prefix.subarray(0, newline).toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof metadata["instanceId"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        metadata["instanceId"],
      ) ||
      typeof metadata["restoreEpoch"] !== "number" ||
      !Number.isSafeInteger(metadata["restoreEpoch"]) ||
      metadata["restoreEpoch"] < 0
    )
      throw new Error("backup snapshot metadata is invalid");
    const remainder = prefix.subarray(newline + 1);
    return {
      instanceId: metadata["instanceId"].toLowerCase(),
      restoreEpoch: metadata["restoreEpoch"],
      dump: (async function* () {
        let header = remainder;
        while (header.length < 5) {
          const next = await iterator.next();
          if (next.done) throw new Error("PostgreSQL dump is missing");
          header = Buffer.concat([header, next.value]);
        }
        if (header.subarray(0, 5).toString("ascii") !== "PGDMP") {
          throw new Error("backup input is not a PostgreSQL custom dump");
        }
        try {
          yield header;
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await iterator.return?.();
        }
      })(),
    };
  }
}
