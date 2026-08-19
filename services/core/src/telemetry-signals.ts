import { metrics } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const meter = metrics.getMeter("violet-core");
const logger = logs.getLogger("violet-core");
const requestCounter = meter.createCounter("violet.http.requests", {
  description: "Count of Core HTTP requests by route and status.",
});

export function recordHttpRequest(input: {
  readonly method: string;
  readonly route: string;
  readonly status: number;
}): void {
  const attributes = {
    "http.request.method": input.method,
    "http.response.status_code": input.status,
    "url.path": input.route,
  };
  requestCounter.add(1, attributes);
  logger.emit({
    attributes: {
      ...attributes,
      "event.name": "http.request.completed",
      status: input.status >= 500 ? "error" : "ok",
    },
    body: "http.request.completed",
    severityNumber: input.status >= 500 ? SeverityNumber.ERROR : SeverityNumber.INFO,
  });
}
