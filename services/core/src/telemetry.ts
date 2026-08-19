import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

export function startTelemetry(env: NodeJS.ProcessEnv): NodeSDK {
  const endpoint = (env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://127.0.0.1:4318").replace(
    /\/$/,
    "",
  );
  const serviceName = env["OTEL_SERVICE_NAME"] ?? "violet-core";
  const serviceVersion = env["VIOLET_VERSION"] ?? "0.1.0-dev";
  const sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${endpoint}/v1/logs`,
        }),
      }),
    ],
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${endpoint}/v1/metrics`,
      }),
      exportIntervalMillis: 10_000,
    }),
    resource: resourceFromAttributes({
      "deployment.environment.name": env["VIOLET_ENVIRONMENT"] ?? "development",
      "service.name": serviceName,
      "service.version": serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
  });
  sdk.start();
  return sdk;
}
