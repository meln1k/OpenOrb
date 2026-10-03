import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { type ConversationView, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { AgentHarnessError } from "../agent-harness.ts";

export const DURABLE_DATABASE = "harness.sqlite";

/** Built-in SQLite storage owns all task/document/submission persistence. */
export async function openDurableStorage(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AgentHarnessError("Harness directory must be a private directory", undefined);
  }
  await chmod(directory, 0o700);
  const path = join(directory, DURABLE_DATABASE);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  await file.close();
  const databaseInfo = await lstat(path);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) {
    throw new AgentHarnessError("Harness storage must be a regular file", undefined);
  }
  await chmod(path, 0o600);
  return openNodeSqliteStorage(path);
}

/** The caller must serialize this with live ownership. Opening never resumes scheduling. */
export async function readDurableView(directory: string): Promise<ConversationView> {
  await using cleanup = new AsyncDisposableStack();
  const storage = await openDurableStorage(directory);
  cleanup.defer(() => storage.close(BACKGROUND_CONTEXT));
  const harness = await Harness.open(storage, {
    models: createModels(),
    registry: createRegistry(),
  }, BACKGROUND_CONTEXT);
  cleanup.defer(() => harness.close(BACKGROUND_CONTEXT));
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const state = await conversation.viewState(BACKGROUND_CONTEXT);
  cleanup.defer(() => state.dispose());
  return state.value;
}
