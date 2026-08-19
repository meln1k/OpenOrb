import { array, literal, object, string, union } from "@remix-run/data-schema";
import type { InferOutput } from "@remix-run/data-schema";
import { validate as validateUuid } from "@std/uuid";

export const ENROLLMENT_PSK_PREFIX = "openorb_enroll_";
export const RUNNER_TOKEN_PREFIX = "openorb_runner_";

export const runnerIdSchema = string().refine(
  validateUuid,
  "Expected a UUID.",
);

export const enrollmentPskSchema = string().refine(
  (value) =>
    value.startsWith(ENROLLMENT_PSK_PREFIX) &&
    value.length > ENROLLMENT_PSK_PREFIX.length &&
    value.length <= 128,
  "Expected an OpenOrb enrollment PSK.",
);

export const runnerTokenSchema = string().refine(
  (value) =>
    value.startsWith(RUNNER_TOKEN_PREFIX) &&
    value.length > RUNNER_TOKEN_PREFIX.length &&
    value.length <= 128,
  "Expected an OpenOrb runner token.",
);

const runnerNameSchema = string().refine(
  (value) => value.trim().length > 0 && value.trim().length <= 100,
  "Runner name must contain between 1 and 100 characters.",
);

const runnerArchitectureSchema = union([
  literal("x64" as const),
  literal("arm64" as const),
]);

const runnerCapabilitiesSchema = array(
  string().refine(
    (value) => value.length > 0 && value.length <= 64,
    "Runner capabilities must contain between 1 and 64 characters.",
  ),
).refine(
  (capabilities) => capabilities.length <= 32 && new Set(capabilities).size === capabilities.length,
  "A runner may advertise at most 32 unique capabilities.",
);

export const runnerEnrollmentRequestSchema = object(
  {
    enrollmentPsk: enrollmentPskSchema,
    name: runnerNameSchema,
    architecture: runnerArchitectureSchema,
    capabilities: runnerCapabilitiesSchema,
  },
  { unknownKeys: "error" },
);

export const runnerEnrollmentResponseSchema = object(
  {
    runnerId: runnerIdSchema,
    runnerToken: runnerTokenSchema,
  },
  { unknownKeys: "error" },
);

export type RunnerArchitecture = InferOutput<typeof runnerArchitectureSchema>;
export type RunnerEnrollmentRequest = InferOutput<typeof runnerEnrollmentRequestSchema>;
export type RunnerEnrollmentResponse = InferOutput<typeof runnerEnrollmentResponseSchema>;
