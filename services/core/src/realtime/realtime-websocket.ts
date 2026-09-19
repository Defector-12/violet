import {
  assertRealtimeClientEvent,
  assertRealtimeServerEvent,
  ProtocolValidationError,
  type RealtimeServerEvent,
} from "@violet/protocol";
import type { WebSocket } from "ws";

import { RealtimeSession, type RealtimeSessionOptions } from "./realtime-session.js";
import { recordTestTrace, type TestTrace, withTestTrace, withTestTraceIds } from "./test-trace.js";

const shutdownTimeoutMs = 5_000;

export interface RealtimeWebSocketHandle {
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
}

export function handleRealtimeWebSocket(
  socket: WebSocket,
  options: RealtimeSessionOptions & { readonly testTrace?: TestTrace },
): RealtimeWebSocketHandle {
  const session = new RealtimeSession(options);
  const abortController = new AbortController();
  let inputQueue = Promise.resolve();
  let outputPump: Promise<void> | null = null;
  let sendQueue = Promise.resolve();
  let sessionId: string | undefined;
  let traceClosed = false;
  let resolveClosed = () => {};
  let firstFailure: unknown;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;

  const closeTrace = () => {
    if (traceClosed) return;
    traceClosed = true;
    try {
      options.testTrace?.record("trace.closed", { sessionId });
    } catch {
      /* Already marked incomplete. */
    }
  };
  const fail = (error: unknown) => {
    firstFailure ??= error;
    try {
      options.testTrace?.record("realtime.failed", {
        sessionId,
        error: error instanceof Error ? error.message : "unknown",
      });
    } catch {
      /* The recorder failure already closes the connection. */
    }
    if (socket.readyState === socket.OPEN) {
      socket.close(1011, "REALTIME_SESSION_FAILED");
    }
  };
  const removeFailureListener = options.testTrace?.onFailure(() => {
    abortController.abort();
    if (socket.readyState === socket.OPEN) socket.close(1011, "TEST_TRACE_INCOMPLETE");
  });
  const sendEvent = (event: RealtimeServerEvent) => {
    recordTestTrace("core.send", event);
    sendQueue = sendQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (socket.readyState !== socket.OPEN) {
            resolve();
            return;
          }
          assertRealtimeServerEvent(event);
          socket.send(JSON.stringify(event), (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    );
    return sendQueue;
  };
  const startOutputPump = () => {
    if (outputPump || !session.configured) {
      return;
    }
    outputPump = withTestTrace(options.testTrace, () =>
      withTestTraceIds(sessionId ? { sessionId } : {}, async () => {
        for await (const event of session.outputs(abortController.signal)) {
          await sendEvent(event);
        }
        if (session.closed && socket.readyState === socket.OPEN) {
          closeTrace();
          socket.close(1011, "REALTIME_SESSION_FAILED");
        }
      }),
    ).catch((error) => {
      fail(error);
      throw error;
    });
    void outputPump.catch(() => undefined);
  };

  socket.on("message", (data, isBinary) => {
    inputQueue = inputQueue
      .then(() =>
        withTestTrace(options.testTrace, async () => {
          if (isBinary) {
            recordTestTrace("protocol.rejected", { reason: "binary-event" });
            socket.close(1003, "INVALID_REALTIME_EVENT");
            return;
          }

          let value: unknown;
          try {
            value = JSON.parse(data.toString());
            assertRealtimeClientEvent(value);
          } catch (error) {
            if (error instanceof SyntaxError || error instanceof ProtocolValidationError) {
              recordTestTrace("protocol.rejected", {
                reason: "invalid-event",
                byteLength: data.toString().length,
              });
              socket.close(1003, "INVALID_REALTIME_EVENT");
              return;
            }
            throw error;
          }

          sessionId = value.sessionId;
          await withTestTraceIds(
            { sessionId, ...("turnId" in value ? { turnId: value.turnId } : {}) },
            async () => {
              recordTestTrace("core.receive", value);
              for await (const event of session.handle(value, abortController.signal)) {
                await sendEvent(event);
              }
            },
          );
          startOutputPump();

          if (session.closed && socket.readyState === socket.OPEN) {
            closeTrace();
            socket.close(1000, "SESSION_CLOSED");
          }
        }),
      )
      .catch((error) => {
        fail(error);
        throw error;
      });
    void inputQueue.catch(() => undefined);
  });

  const close = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      removeFailureListener?.();
      closeTrace();
      abortController.abort();
      if (socket.readyState === socket.OPEN) {
        socket.close(1001, "SERVER_SHUTDOWN");
      }
      const operations = Promise.allSettled([
        session.close(),
        inputQueue,
        outputPump ?? Promise.resolve(),
        sendQueue,
      ]);
      let timeout: NodeJS.Timeout | undefined;
      const results = await Promise.race([
        operations,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), shutdownTimeoutMs);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (!results) {
        const error = new Error("Realtime session shutdown timed out");
        fail(error);
        if (socket.readyState !== socket.CLOSED) {
          socket.terminate();
        }
        resolveClosed();
        throw error;
      }
      for (const result of results) {
        if (result.status === "rejected") {
          fail(result.reason);
        }
      }
      resolveClosed();
      if (firstFailure) {
        throw firstFailure;
      }
    })();
    return shutdownPromise;
  };
  socket.once("close", () => {
    void close().catch(fail);
  });
  return { close, closed };
}
