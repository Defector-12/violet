import { once } from "node:events";
import WebSocket from "ws";
import { abortReason } from "./async-queue.js";

export async function connectProviderSocket(
  socket: WebSocket,
  provider: string,
  signal?: AbortSignal,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  const closed = new AbortController();
  const setupSignal = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
  const onClose = () =>
    closed.abort(new Error(`${provider} realtime connection closed during setup`));
  socket.once("close", onClose);
  try {
    await once(socket, "open", { signal: setupSignal });
  } catch (error) {
    throw setupSignal.aborted ? abortReason(setupSignal) : error;
  } finally {
    socket.off("close", onClose);
  }
}

export async function sendProviderData(
  socket: WebSocket,
  provider: string,
  data: string | Uint8Array,
): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error(`${provider} realtime connection is not open`);
  }
  await new Promise<void>((resolve, reject) => {
    socket.send(data, (error) => (error ? reject(error) : resolve()));
  });
}
