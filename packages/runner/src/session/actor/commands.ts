import type {
  GitMutationRevision,
  SessionEnvironmentSecret,
  SessionModelRuntime,
  SubmissionId,
  ThinkingLevel,
} from "@openorb/protocol/runner-api";
import type { RunnerSessionMetadata } from "./state.ts";

export type GitFileUpdateAcceptance =
  | { readonly ok: true; readonly mutationRevision: GitMutationRevision }
  | { readonly ok: false; readonly message: string };
export type WakeAcceptance = { readonly ok: true } | {
  readonly ok: false;
  readonly message: string;
};
export type AbortAcceptance = WakeAcceptance;
export type StopAcceptance = WakeAcceptance;
export type DeletionAcceptance = WakeAcceptance;
export type PromptAcceptance =
  | { readonly ok: true; readonly submissionId: SubmissionId }
  | { readonly ok: false; readonly message: string };
export type ThinkingLevelAcceptance =
  | { readonly ok: true; readonly level: ThinkingLevel }
  | { readonly ok: false; readonly message: string };

interface SessionActorInputBase {
  readonly metadata: RunnerSessionMetadata;
  readonly idleTimeoutMs: number;
}
export type SessionActorInput =
  & SessionActorInputBase
  & (
    | { readonly mode: "restore" }
    | {
      readonly mode: "reconcile";
      readonly trigger: "runner-start" | "provision-request" | "actor-crash";
    }
    | {
      readonly mode: "create" | "retry";
      readonly githubToken?: string | undefined;
      readonly environmentSecrets?: readonly SessionEnvironmentSecret[] | undefined;
      readonly modelRuntime: SessionModelRuntime;
    }
  );

export interface ProvisioningLogBudget {
  remainingBytes: number;
  truncated: boolean;
  secrets: string[];
}
export interface ProvisioningUpdate {
  readonly checkoutState: RunnerSessionMetadata["checkoutState"];
  readonly baseCommit?: string;
}
