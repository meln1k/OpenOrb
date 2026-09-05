import { tryAsync } from "@openorb/result";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Middleware } from "remix/router";

const tracer = trace.getTracer("openorb-gateway", "0.0.0");

/** Only pass fixed operation names, never request data or exception messages. */
export function sessionSpan<T>(operation: string, run: () => Promise<T>): Promise<T> {
  sessionStage(operation);
  return tracer.startActiveSpan(`sessions.api.${operation}`, async (span) => {
    using cleanup = new DisposableStack();
    cleanup.defer(() => span.end());
    const [value, failure] = await tryAsync(Promise.resolve().then(run), (cause) => ({ cause }));
    if (failure !== undefined) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Operation threw" });
      // Raw exceptions can contain credentials, SQL parameters, or runner output.
      span.addEvent("exception", { "exception.type": "SessionApiOperationError" });
      throw failure.cause;
    }
    return value;
  });
}

export function sessionCsrfStage(): Middleware {
  return (_context, next) => {
    sessionStage("csrf");
    return next();
  };
}

export function sessionApiTelemetry(): Middleware {
  return (_context, next) =>
    sessionSpan("request", async () => {
      sessionStage("auth");
      const response = await next();
      trace.getActiveSpan()?.setAttribute("http.response.status_code", response.status);
      if (response.status >= 400) {
        trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
      }
      return response;
    });
}

export function sessionStage(stage: string): void {
  trace.getActiveSpan()?.setAttribute("sessions.api.stage", stage);
}

export function sessionRejection(reason: string): void {
  trace.getActiveSpan()?.setAttribute("sessions.api.rejection", reason);
  trace.getActiveSpan()?.addEvent("request.rejected", { reason });
}
