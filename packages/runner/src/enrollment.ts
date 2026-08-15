import {
  type RunnerArchitecture,
  type RunnerEnrollmentResponse,
  runnerEnrollmentResponseSchema,
} from "@openorb/protocol";
import { parse } from "@remix-run/data-schema";

const ENROLLMENT_TIMEOUT_MS = 15_000;

export interface EnrollRunnerOptions {
  controlPanelUrl: string;
  enrollmentPsk: string;
  name: string;
  architecture: RunnerArchitecture;
  capabilities: string[];
  fetch?: typeof fetch;
}

export async function enrollRunner(
  options: EnrollRunnerOptions,
): Promise<RunnerEnrollmentResponse> {
  const fetchImplementation = options.fetch ?? fetch;
  const response = await fetchImplementation(
    new URL("/api/runners/enroll", options.controlPanelUrl),
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
  );
  if (!response.ok) {
    throw new Error(`Runner enrollment failed with HTTP ${response.status}.`);
  }

  try {
    return parse(runnerEnrollmentResponseSchema, await response.json());
  } catch {
    throw new Error("Control panel returned an invalid enrollment response.");
  }
}
