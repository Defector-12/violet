import { startTelemetry } from "./telemetry.js";

const telemetry = startTelemetry(process.env);

const shutdown = async () => {
  await telemetry.shutdown();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await import("./main.js");
