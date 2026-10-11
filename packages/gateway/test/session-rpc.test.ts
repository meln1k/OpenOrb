import { assertEquals, assertInstanceOf } from "@std/assert";
import { RunnerSessionSnapshot, SessionGitSnapshot } from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import {
  decodeSessionRpc,
  encodeGitSnapshot,
  encodeSessionView,
  type SessionRpc,
} from "../app/cells/session/api.ts";
import { staleGitSnapshot } from "../app/cells/session/git-snapshot.ts";

const snapshot = Schema.decodeUnknownSync(RunnerSessionSnapshot)({
  id: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  createdAt: new Date(0).toISOString(),
  initialPromptPreview: "Inspect the repository",
  model: "openai-codex/gpt-5.5",
  initialThinkingLevel: "medium",
  orbSize: "tiny",
  state: "error",
  agentState: "idle",
  environmentState: "error",
  issues: [{
    category: "clone",
    severity: "failure",
    message: "The repository could not be cloned.",
    recovery: "retry-provisioning",
  }],
});

Deno.test("Session views and Git Snapshots survive native RPC's structured clone", async () => {
  const git = staleGitSnapshot();
  // SAFETY: only the two encoded results are exercised; other methods are never called.
  const rpc = {
    view: () => Promise.resolve(structuredClone(encodeSessionView({ runnerId: "r", snapshot }))),
    gitSnapshot: () => Promise.resolve(structuredClone(encodeGitSnapshot(git))),
  } as SessionRpc;
  const api = decodeSessionRpc(rpc, () => Promise.reject(new Error("unused")));
  const view = await api.view();
  assertInstanceOf(view?.snapshot, RunnerSessionSnapshot);
  assertEquals(view.snapshot, snapshot);
  const decoded = await api.gitSnapshot();
  assertInstanceOf(decoded, SessionGitSnapshot);
  assertEquals(decoded, git);
});
