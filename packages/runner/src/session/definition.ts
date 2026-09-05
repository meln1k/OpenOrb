import {
  GitAuthor,
  initialPromptPreview,
  ModelReference,
  OrbSize,
  ProjectId,
  SessionGitReference,
  SessionRepositoryUrl,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";

const StoredInitialPrompt = Schema.String.check(
  Schema.makeFilter((value) =>
    initialPromptPreview(value).length > 0
      ? undefined
      : "The initial prompt must contain non-whitespace text."
  ),
);

export class RunnerSessionDefinition extends Schema.Class<RunnerSessionDefinition>(
  "RunnerSessionDefinition",
)({
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  repositoryUrl: SessionRepositoryUrl,
  ref: SessionGitReference,
  branchName: SessionGitReference,
  gitAuthor: GitAuthor,
  initialPrompt: StoredInitialPrompt,
  model: ModelReference,
  orbSize: OrbSize,
}) {}

export const runnerSessionDefinitionsEqual = Schema.toEquivalence(RunnerSessionDefinition);
