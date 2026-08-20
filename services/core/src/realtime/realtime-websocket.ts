import {
  assertRealtimeClientEvent,
  assertRealtimeServerEvent,
  ProtocolValidationError,
} from "@violet/protocol";
import type { WebSocket } from "ws";

import { RealtimeSession, type RealtimeSessionOptions } from "./realtime-session.js";

export function handleRealtimeWebSocket(socket: WebSocket, options: RealtimeSessionOptions): void {
  const session = new RealtimeSession(options);
  const abortController = new AbortController();
  let queue = Promise.resolve();

  socket.on("message", (data, isBinary) => {
    queue = queue
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
          if (socket.readyState !== socket.OPEN) {
            return;
          }
          assertRealtimeServerEvent(event);
          socket.send(JSON.stringify(event));
        }

        if (session.closed && socket.readyState === socket.OPEN) {
          socket.close(1000, "SESSION_CLOSED");
        }
      })
      .catch(() => {
        if (socket.readyState === socket.OPEN) {
          socket.close(1011, "REALTIME_SESSION_FAILED");
        }
      });
  });

  socket.once("close", () => {
    abortController.abort();
    void session.close();
  });
}
