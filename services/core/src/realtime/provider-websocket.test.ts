import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { connectProviderSocket, sendProviderData } from "./provider-websocket.js";

describe("provider WebSocket transport", () => {
  it("connects and sends both JSON and binary frames over a local socket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const connection = once(server, "connection");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      await connectProviderSocket(socket, "Qwen");
      await connectProviderSocket(socket, "DashScope");
      const [peer] = (await connection) as [WebSocket];
      for (const data of ['{"type":"session.update"}', new Uint8Array([0, 255, 128])]) {
        const received = once(peer, "message");
        await sendProviderData(socket, "DashScope", data);
        const [message, binary] = await received;
        expect(binary).toBe(typeof data !== "string");
        expect(message).toEqual(Buffer.from(data));
      }
      const closed = once(socket, "close");
      socket.close();
      await closed;
      await expect(sendProviderData(socket, "Qwen", "{}")).rejects.toThrow("is not open");
    } finally {
      socket.terminate();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["error", "close", "abort", "already-aborted"] as const)(
    "preserves setup failure and cleans listeners after %s",
    async (outcome) => {
      const socket = Object.assign(new EventEmitter(), {
        readyState: WebSocket.CONNECTING,
      }) as WebSocket;
      const controller = new AbortController();
      const failure = new Error("connection interrupted");
      // Provider transports retain their own error listener after setup completes.
      const onError = () => {};
      socket.on("error", onError);
      if (outcome === "already-aborted") controller.abort(failure);
      const connecting = connectProviderSocket(socket, "Qwen", controller.signal);
      const rejected = expect(connecting).rejects.toThrow(
        outcome === "close" ? "Qwen realtime connection closed during setup" : failure,
      );
      if (outcome === "abort") controller.abort(failure);
      if (outcome === "error") socket.emit("error", failure);
      if (outcome === "close") socket.emit("close");
      await rejected;
      expect(socket.listeners("open")).toEqual([]);
      expect(socket.listeners("close")).toEqual([]);
      expect(socket.listeners("error")).toEqual([onError]);
    },
  );
});
