import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type {
  SessionEvent,
  SessionGitFileAction,
  SessionGitSnapshot,
  SessionIssue,
} from "@openorb/protocol/runner-api";
import type { SessionGitPatchSection } from "@openorb/protocol/runner-bulk-api";
import { tryAsync } from "@openorb/result";
import { SessionError } from "./agent.ts";
import {
  generateGitSnapshot,
  type GitPatchChunk,
  readGitPatchChunk,
  staleGitSnapshot,
  updateGitFile,
} from "./git-snapshot.ts";
import {
  type CheckoutResult,
  provisionCheckout,
  type ProvisioningReporter,
  resumeCheckout,
} from "./provisioning.ts";
import {
  readGitSnapshot,
  type SessionProject,
  type SessionRecord,
  writeGitSnapshot,
} from "./record.ts";
import {
  discoverRepositorySkills,
  repositorySkillsPrompt,
  SKILLS_PENDING_PROMPT,
} from "./skills.ts";

const context = BACKGROUND_CONTEXT;
/** Git Snapshot refreshes: debounce tool boundaries, and refresh periodically during a run. */
export const GIT_REFRESH_DEBOUNCE_MS = 1_000;
const GIT_REFRESH_INTERVAL_MS = 15_000;
const SKILL_DISCOVERY_TIMEOUT_MS = 10_000;

/** The parts of the Session Durable Object a project's integration works through. */
export interface ProjectHost {
  /** The guest, without the readiness gate: project work is what the gate waits for. */
  readonly env: ExecutionEnv;
  readonly storage: DurableObjectSqliteStorage;
  readonly record: () => SessionRecord | undefined;
  readonly update: (update: Partial<SessionRecord>) => void;
  readonly publish: (event: SessionEvent) => void;
  /** Keeps background work alive; its failures are the work's own concern. */
  readonly background: (work: Promise<unknown>) => void;
  readonly busy: () => boolean;
}

interface GitRefreshState {
  /** The refresh loop, kept alive in the background while it runs. */
  loop: Promise<void> | undefined;
  /** When the next refresh is due, in epoch milliseconds; absent when none is requested. */
  dueAt: number | undefined;
  /** Ends the loop's wait early when a sooner refresh is requested. */
  wake: (() => void) | undefined;
}

/**
 * Everything a Session with a project adds to its Agent Environment: the Project Checkout and its
 * hooks, the repository skills catalog, and Git Snapshots (ADRs 0006 and 0007). A Session without
 * a project has none of this; its runtime simply has no integration.
 */
export class ProjectIntegration {
  readonly #host: ProjectHost;
  readonly #refresh: GitRefreshState = { loop: undefined, dueAt: undefined, wake: undefined };
  /** Loaded once from the first checkout, then fixed for the Session; see `loadSkills`. */
  #skills: string | undefined;
  #skillsScan: Promise<void> | undefined;

  constructor(
    readonly project: SessionProject,
    host: ProjectHost,
    /** The catalog the transcript shows the model was given, if any. */
    shownSkills: string | undefined,
  ) {
    this.#host = host;
    this.#skills = shownSkills;
  }

  /** The repository skills prompt section; pending until the first checkout's catalog loads. */
  skillsPrompt(): string {
    return this.#skills ?? SKILLS_PENDING_PROMPT;
  }

  /** Clones the project, creates the session branch, and runs `.agents/setup`. */
  provision(
    reporter: ProvisioningReporter,
    secrets: readonly string[],
    context: Context,
  ): Promise<CheckoutResult> {
    return provisionCheckout(
      this.#host.env,
      this.project,
      {
        ...reporter,
        // Skills are repository content; load them before setup, which may take minutes.
        checkedOut: (baseCommit) => {
          this.#host.update({ checkoutState: "available", baseCommit });
          this.#host.background(this.loadSkills());
        },
      },
      secrets,
      context,
    );
  }

  /** Runs `.agents/resume` after a restart of an available checkout. */
  resume(
    reporter: ProvisioningReporter,
    secrets: readonly string[],
    context: Context,
  ): Promise<readonly SessionIssue[]> {
    return resumeCheckout(this.#host.env, reporter, secrets, context);
  }

  /**
   * Loads repository skills once, from the first checkout. The catalog then stays fixed for the
   * Session: a changed system prompt section would rewrite the model's cached prompt prefix. It is
   * kept only in the transcript, so a load the model has not yet been shown is redone after an
   * eviction; a failed load is retried at the next start or reopen. Never blocks the agent.
   */
  loadSkills(): Promise<void> {
    const record = this.#host.record();
    if (
      this.#skills !== undefined ||
      this.#skillsScan !== undefined ||
      record?.checkoutState !== "available" ||
      record.environmentState !== "running"
    )
      return this.#skillsScan ?? Promise.resolve();
    this.#skillsScan = (async () => {
      const [skills, failure] = await tryAsync(
        discoverRepositorySkills(
          this.#host.env,
          withAbortSignal(AbortSignal.timeout(SKILL_DISCOVERY_TIMEOUT_MS), context),
        ),
        () => new SessionError("Repository skill discovery failed or timed out."),
      );
      if (failure !== undefined) return;
      this.#skills ??= repositorySkillsPrompt(skills);
    })().finally(() => {
      this.#skillsScan = undefined;
    });
    return this.#skillsScan;
  }

  /** Requests a Git Snapshot refresh within `delayMs`; a sooner request wins. */
  scheduleRefresh(delayMs: number): void {
    const state = this.#refresh;
    const dueAt = Date.now() + delayMs;
    if (state.dueAt === undefined || dueAt < state.dueAt) {
      state.dueAt = dueAt;
      state.wake?.();
    }
    if (state.loop !== undefined) return;
    state.loop = this.#refreshLoop().finally(() => {
      state.loop = undefined;
    });
    this.#host.background(state.loop);
  }

  /** Refreshes the Git Snapshot now; failure keeps the previous one, marked stale. */
  async refresh(): Promise<void> {
    const record = this.#host.record();
    if (
      record === undefined ||
      record.checkoutState !== "available" ||
      record.environmentState !== "running" ||
      !record.environmentReachable ||
      record.operation !== undefined
    )
      return;
    const previous = readGitSnapshot(this.#host.storage);
    const [snapshot, failure] = await tryAsync(
      generateGitSnapshot(this.#host.env, record, context),
      (cause) => new SessionError("The Git Snapshot could not be refreshed.", { cause }),
    );
    if (failure !== undefined) {
      this.#store(previous, staleGitSnapshot(previous));
      return;
    }
    this.#store(previous, snapshot);
  }

  /** One byte range of a full patch, read from the guest; needs a running environment. */
  async patchChunk(input: {
    snapshotId: string;
    section: SessionGitPatchSection;
    offset: number;
  }): Promise<GitPatchChunk> {
    const snapshot = readGitSnapshot(this.#host.storage);
    if (snapshot?.snapshotId !== input.snapshotId) {
      throw new SessionError("This Git Snapshot was replaced; refresh the changes view.");
    }
    const record = this.#host.record();
    if (record?.environmentState !== "running" || !record.environmentReachable) {
      throw new SessionError("Start the environment to load the full diff.");
    }
    return await readGitPatchChunk(
      this.#host.env,
      input.snapshotId,
      input.section,
      input.offset,
      snapshot.sections[input.section].fullPatchBytes ?? 0,
      context,
    );
  }

  /** Stages or unstages one file and returns the new mutation revision. */
  async updateFile(input: {
    action: SessionGitFileAction;
    path: string;
    previousPath?: string;
  }): Promise<number> {
    const record = this.#host.record()!;
    const result = await updateGitFile(this.#host.env, record, input, context);
    if (!result.ok) {
      this.scheduleRefresh(0);
      throw new SessionError(result.message);
    }
    const mutationRevision = record.gitMutationRevision + 1;
    this.#host.update({ gitMutationRevision: mutationRevision });
    this.scheduleRefresh(0);
    return mutationRevision;
  }

  /**
   * Refreshes never overlap: a request during one runs once more after it, and a busy agent's
   * changes refresh periodically. Waits stay inside this background promise, because a timer set
   * after its request context has ended may never fire.
   */
  async #refreshLoop(): Promise<void> {
    const state = this.#refresh;
    while (state.dueAt !== undefined) {
      const wait = state.dueAt - Date.now();
      if (wait > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        state.wake = resolve;
        const timer = setTimeout(resolve, wait);
        await promise;
        clearTimeout(timer);
        state.wake = undefined;
        continue;
      }
      state.dueAt = undefined;
      await this.refresh();
      if (this.#host.busy() && state.dueAt === undefined) {
        state.dueAt = Date.now() + GIT_REFRESH_INTERVAL_MS;
      }
    }
  }

  #store(previous: SessionGitSnapshot | undefined, next: SessionGitSnapshot): void {
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return;
    writeGitSnapshot(this.#host.storage, next);
    this.#host.publish({ type: "git.snapshot.updated" });
  }
}
