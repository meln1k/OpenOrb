import { literal, object, optional, string, union } from "@remix-run/data-schema";

import { projectIdSchema, runnerSessionSnapshotSchema } from "@/src/runner-session-inventory.ts";
import type { InferOutput } from "@remix-run/data-schema";
import type { RunnerMessage } from "@/src/runner-message.ts";
import { runnerCheckoutStateSchema } from "@/src/runner-session-events.ts";
import type { OptionalSchemaProperties } from "@/src/schema-output.ts";

export const SESSION_PROVISION_MESSAGE_TYPE = "session.provision";
export const SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE = "session.provision.accepted";
export const SESSION_PROVISION_REJECTED_MESSAGE_TYPE = "session.provision.rejected";

export const MAX_INITIAL_PROMPT_BYTES = 32 * 1024;

export const sessionRepositoryUrlSchema = string().refine(
  isCanonicalGitHubRepository,
  "Expected a canonical GitHub HTTPS repository URL.",
);

export const sessionGitRefSchema = string().refine(
  isSafeGitReference,
  "Expected a valid Git branch or tag reference.",
);

export const sessionBranchNameSchema = string().refine(
  isSafeGitReference,
  "Expected a valid Git branch name.",
);

const initialPromptSchema = string().refine(
  (value) => value.trim().length > 0 && byteLength(value) <= MAX_INITIAL_PROMPT_BYTES,
  `Initial prompts must contain text and be at most ${MAX_INITIAL_PROMPT_BYTES} UTF-8 bytes.`,
);

const githubTokenSchema = string().refine(
  (value) => value.length > 0 && value.length <= 4096 && value.trim() === value,
  "GitHub tokens must be trimmed values of at most 4096 characters.",
);

const createPayloadSchema = object(
  {
    mode: literal("create" as const),
    projectId: projectIdSchema,
    repositoryUrl: sessionRepositoryUrlSchema,
    ref: sessionGitRefSchema,
    branchName: sessionBranchNameSchema,
    initialPrompt: initialPromptSchema,
    githubToken: optional(githubTokenSchema),
  },
  { unknownKeys: "error" },
);

const retryPayloadSchema = object(
  {
    mode: literal("retry" as const),
    githubToken: optional(githubTokenSchema),
  },
  { unknownKeys: "error" },
);

export const sessionProvisionCommandPayloadSchema = union([
  createPayloadSchema,
  retryPayloadSchema,
]);

export type SessionProvisionCommandPayload = OptionalSchemaProperties<
  InferOutput<typeof sessionProvisionCommandPayloadSchema>,
  "githubToken"
>;

export type SessionProvisionCommand = RunnerMessage<SessionProvisionCommandPayload> & {
  type: typeof SESSION_PROVISION_MESSAGE_TYPE;
  sessionId: string;
};

export const sessionProvisionAcceptedPayloadSchema = object(
  {
    session: runnerSessionSnapshotSchema,
    ref: sessionGitRefSchema,
    branchName: sessionBranchNameSchema,
    checkoutState: runnerCheckoutStateSchema,
  },
  { unknownKeys: "error" },
);

export type SessionProvisionAcceptedPayload = InferOutput<
  typeof sessionProvisionAcceptedPayloadSchema
>;

export type SessionProvisionAcceptedMessage = RunnerMessage<SessionProvisionAcceptedPayload> & {
  type: typeof SESSION_PROVISION_ACCEPTED_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

export const sessionProvisionRejectedPayloadSchema = object(
  {
    message: string().refine(
      (value) => value.trim().length > 0 && value.length <= 1000,
      "Provisioning rejection messages must contain at most 1000 characters.",
    ),
  },
  { unknownKeys: "error" },
);

export type SessionProvisionRejectedPayload = InferOutput<
  typeof sessionProvisionRejectedPayloadSchema
>;

export type SessionProvisionRejectedMessage = RunnerMessage<SessionProvisionRejectedPayload> & {
  type: typeof SESSION_PROVISION_REJECTED_MESSAGE_TYPE;
  sessionId: string;
  correlationId: string;
};

function isCanonicalGitHubRepository(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(".git")
  ) {
    return false;
  }
  const parts = url.pathname.slice(1, -4).split("/");
  const owner = parts[0];
  const repository = parts[1];
  return parts.length === 2 &&
    owner !== undefined &&
    repository !== undefined &&
    /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repository) &&
    repository !== "." &&
    repository !== ".." &&
    value === `https://github.com/${owner}/${repository}.git`;
}

function isSafeGitReference(value: string): boolean {
  return value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
