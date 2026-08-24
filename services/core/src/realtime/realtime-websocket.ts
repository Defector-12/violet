import {
  assertRealtimeClientEvent,
  assertRealtimeServerEvent,
  ProtocolValidationError,
  type RealtimeServerEvent,
} from "@violet/protocol";
import type { WebSocket } from "ws";

import { RealtimeSession, type RealtimeSessionOptions } from "./realtime-session.js";

export function handleRealtimeWebSocket(socket: WebSocket, options: RealtimeSessionOptions): void {
  const session = new RealtimeSession(options);
  const abortController = new AbortController();
  let inputQueue = Promise.resolve();
  let outputPump: Promise<void> | null = null;
  let sendQueue = Promise.resolve();

  const fail = () => {
    if (socket.readyState === socket.OPEN) {
      socket.close(1011, "REALTIME_SESSION_FAILED");
    }
  };
  const sendEvent = (event: RealtimeServerEvent) => {
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
    outputPump = (async () => {
      for await (const event of session.outputs(abortController.signal)) {
        await sendEvent(event);
      }
    })().catch(fail);
  };

  socket.on("message", (data, isBinary) => {
    inputQueue = inputQueue
      .then(async () => {
        if (isBinary) {
          socket.close(1003, "INVALID_REALTIME_EVENT");
          return;
        }

        let value: unknown;
        try {
          value = JSON.parse(data.toString());
          assertRealtimeClientEvent(value);
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof ProtocolValidationError) {
            socket.close(1003, "INVALID_REALTIME_EVENT");
            return;
          }
          throw error;
        }

        for await (const event of session.handle(value, abortController.signal)) {
          await sendEvent(event);
        }
        startOutputPump();

        if (session.closed && socket.readyState === socket.OPEN) {
          socket.close(1000, "SESSION_CLOSED");
        }
      })
      .catch(fail);
  });

  socket.once("close", () => {
    abortController.abort();
    void session.close();
  });
}
