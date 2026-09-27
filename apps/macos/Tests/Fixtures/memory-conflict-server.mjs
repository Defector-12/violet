import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const instanceId = randomUUID();
const missingRequestId = process.argv[2] === "missing-request-id";
let rejectedId;
let completed = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const send = (status, payload) => {
    console.error(
      JSON.stringify({
        method: request.method,
        path: request.url,
        body,
        status,
        response: payload,
      }),
    );
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(payload));
  };
  if (request.method === "GET" && request.url === "/v1/memories") {
    send(200, {
      instanceId,
      revision: 1,
      deletionRevision: completed ? 1 : 0,
      restoreEpoch: completed ? 1 : 0,
      memories: [],
    });
  } else if (request.method === "POST" && request.url === "/v1/memory-deletions/previews") {
    send(200, {
      id: body.id,
      instanceId,
      revision: 1,
      deletionRevision: 0,
      restoreEpoch: 0,
      nextRestoreEpoch: 1,
      eventSequence: 1,
      target: body.target,
      requestIds: [],
      eventIds: [],
      deletedMemoryIds: [],
      retainedMemoryIds: [],
      createdAt: "2026-09-25T00:00:00.000Z",
      events: [],
      memories: [],
    });
  } else if (
    request.method === "POST" &&
    /^\/v1\/memory-deletions\/[^/]+\/confirm$/u.test(request.url)
  ) {
    const id = request.url.split("/")[3];
    rejectedId ??= id;
    if (id === rejectedId) {
      // Match the shared ApiError wire contract; no Swift error is injected.
      send(409, {
        code: "MEMORY_CONFLICT",
        message: "Deletion impact changed",
        retryable: true,
        ...(missingRequestId ? {} : { requestId: randomUUID() }),
      });
    } else if (body.instanceId === instanceId && body.minimumRestoreEpoch === 1) {
      completed = true;
      send(200, { id, instanceId, restoreEpoch: 1, status: "pending" });
    } else {
      send(400, {
        code: "INVALID_MEMORY_REQUEST",
        message: "Unexpected confirmation",
        requestId: randomUUID(),
        retryable: false,
      });
    }
  } else {
    send(404, {
      code: "MEMORY_NOT_FOUND",
      message: "Unexpected fixture request",
      requestId: randomUUID(),
      retryable: false,
    });
  }
});
const timeout = setTimeout(() => {
  server.closeAllConnections();
  server.close();
}, 15_000);
server.on("close", () => clearTimeout(timeout));
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
