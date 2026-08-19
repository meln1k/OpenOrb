import {
  type RunnerArchitecture,
  type RunnerEnrollmentResponse,
  runnerEnrollmentResponseSchema,
} from "@openorb/protocol";
import { parse } from "@remix-run/data-schema";
import { err, ok, type Result, tryAsync } from "@openorb/result";

const ENROLLMENT_TIMEOUT_MS = 15_000;

export interface EnrollRunnerOptions {
  gatewayUrl: string;
  enrollmentPsk: string;
  name: string;
  architecture: RunnerArchitecture;
  capabilities: string[];
  fetch?: typeof fetch;
}

export async function enrollRunner(
  options: EnrollRunnerOptions,
): Promise<Result<RunnerEnrollmentResponse, RunnerEnrollmentError>> {
  const fetchImplementation = options.fetch ?? fetch;
  const [response, networkError] = await tryAsync(
    Promise.resolve().then(() =>
      fetchImplementation(
        new URL("/api/runners/enroll", options.gatewayUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enrollmentPsk: options.enrollmentPsk,
            name: options.name,
            architecture: options.architecture,
            capabilities: options.capabilities,
          }),
          signal: AbortSignal.timeout(ENROLLMENT_TIMEOUT_MS),
        },
      )
    ),
    (cause) => new RunnerEnrollmentError("Runner enrollment could not reach the gateway.", cause),
  );
  if (networkError !== undefined) return err(networkError);
  if (!response.ok) {
    return err(
      new RunnerEnrollmentError(
        `Runner enrollment failed with HTTP ${response.status}.`,
        undefined,
      ),
    );
  }

  const [enrolled, responseError] = await tryAsync(
    response.json().then((value) => parse(runnerEnrollmentResponseSchema, value)),
    (cause) =>
      new RunnerEnrollmentError(
        "Gateway returned an invalid enrollment response.",
        cause,
      ),
  );
  if (responseError !== undefined) return err(responseError);
  return ok(enrolled);
}

export class RunnerEnrollmentError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerEnrollmentError";
  }
}
