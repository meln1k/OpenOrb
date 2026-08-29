import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@remix-run/data-schema";

import { runnerEnrollmentRequestSchema, runnerEnrollmentResponseSchema } from "@/src/index.ts";

const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const ENROLLMENT_PSK = `openorb_enroll_${"a".repeat(43)}`;
const RUNNER_TOKEN = `openorb_runner_${"b".repeat(43)}`;

Deno.test("validates runner enrollment request and response payloads", () => {
  assertEquals(
    parse(runnerEnrollmentRequestSchema, {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
    }),
    {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "arm64",
    },
  );
  assertEquals(
    parse(runnerEnrollmentResponseSchema, { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN }),
    { runnerId: RUNNER_ID, runnerToken: RUNNER_TOKEN },
  );

  assertThrows(() =>
    parse(runnerEnrollmentRequestSchema, {
      enrollmentPsk: ENROLLMENT_PSK,
      name: "Home runner",
      architecture: "riscv64",
    })
  );
});
