import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../../services/core/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
const expected = process.argv[2] === "memory";
const timeout = setTimeout(() => {
  for (const socket of server.clients) socket.terminate();
  server.close();
}, 10_000);
server.on("listening", () => console.log(server.address().port));
server.on("connection", (socket) => {
  let sequence = 1;
  let replied = false;
  socket.on("message", (data) => {
    const input = JSON.parse(data.toString());
    const send = (event) =>
      socket.send(
        JSON.stringify({
          eventId: randomUUID(),
          sessionId: input.sessionId,
          sequence: sequence++,
          ...event,
        }),
      );
    if (input.type === "session.configure") {
      send({
        type: "session.ready",
        capabilities: {
          inputAudio: { channels: 1, encoding: "pcm_s16le", sampleRate: 16000 },
          inputModalities: ["audio", "text"],
          interruption: false,
          outputAudio: { channels: 1, encoding: "pcm_s16le", sampleRate: 24000 },
          outputModalities: ["audio", "text"],
          runtimeKind: "integrated",
          transcription: true,
          turnDetection: "smart_turn",
          voiceKind: "preset",
        },
      });
    } else if (input.type === "input.audio" && !replied) {
      replied = true;
      const turnId = randomUUID(),
        responseId = randomUUID();
      send({ type: "response.started", turnId, responseId });
      send({
        type: "response.audio",
        turnId,
        responseId,
        audio: Buffer.alloc(19200).toString("base64"),
      });
      send({ type: "response.completed", turnId, responseId });
      if (expected) send({ type: "session.end_requested", turnId, reason: "memory_changed" });
      socket.close(expected ? 1000 : 1011, expected ? "MEMORY_CHANGED" : "REALTIME_SESSION_FAILED");
    }
  });
  socket.on("close", () => {
    clearTimeout(timeout);
    server.close();
  });
});
