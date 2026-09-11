import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";

import {
  SessionChangesResource,
  type SessionChangesViewOwner,
} from "./session-changes-resource.tsx";
import { SessionPageController } from "./session-page-controller.tsx";

Deno.test("session changes share one lazy refresh pipeline across responsive views", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const sidebar: SessionChangesViewOwner = { variant: "sidebar" };
  const content: SessionChangesViewOwner = { variant: "content" };
  let requests = 0;
  const fetchSnapshot: typeof fetch = () => {
    requests++;
    return Promise.resolve(Response.json(emptySnapshot(`snapshot-${requests}`)));
  };
  globalThis.fetch = fetchSnapshot;

  try {
    const page = new SessionPageController("ready", []);
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(page);

    page.apply({ type: "git.snapshot.updated" });
    assertEquals(requests, 0);

    const firstLoad = waitForSnapshot(changes, "snapshot-1");
    changes.setViewActive(sidebar, true);
    changes.setViewActive(content, true);
    await firstLoad;
    assertEquals(requests, 1);

    changes.setViewActive(sidebar, false);
    changes.setViewActive(content, false);
    page.apply({ type: "git.snapshot.updated" });
    assertEquals(requests, 1);

    const secondLoad = waitForSnapshot(changes, "snapshot-2");
    changes.setViewActive(content, true);
    await secondLoad;
    assertEquals(requests, 2);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("POST acknowledgement stops spinning before snapshot reconciliation", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const mutationResponse = Promise.withResolvers<Response>();
  const reconciliationResponse = Promise.withResolvers<Response>();
  const reconciliationRequested = Promise.withResolvers<void>();
  let snapshotRequests = 0;
  globalThis.fetch = (input) => {
    if (!String(input).includes("git-snapshot")) return mutationResponse.promise;
    snapshotRequests++;
    if (snapshotRequests === 1) {
      return Promise.resolve(Response.json(fileSnapshot("initial", "unstaged")));
    }
    reconciliationRequested.resolve();
    return reconciliationResponse.promise;
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const initial = waitForSnapshot(changes, "initial");
    changes.setViewActive(view, true);
    await initial;

    const stage = changes.updateFile("stage", "src/main.ts");
    assertEquals(projectedRow(changes, "src/main.ts")?.pending, {
      path: "src/main.ts",
      requestPending: true,
    });

    mutationResponse.resolve(mutationAccepted(1));
    await stage;
    await reconciliationRequested.promise;
    assertEquals(projectedRow(changes, "src/main.ts")?.state, "staged");
    assertEquals(projectedRow(changes, "src/main.ts")?.pending, {
      path: "src/main.ts",
      requestPending: false,
    });

    const reconciled = waitForProjectedFile(changes, "reconciled", "staged", false);
    reconciliationResponse.resolve(Response.json(fileSnapshot("reconciled", "staged", 1)));
    await reconciled;
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("newer optimistic file generations survive older snapshot reconciliation", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const stageResponse = Promise.withResolvers<Response>();
  const unstageResponse = Promise.withResolvers<Response>();
  const actions: string[] = [];
  let snapshotRequests = 0;
  globalThis.fetch = (input, init) => {
    if (String(input).includes("git-snapshot")) {
      snapshotRequests++;
      return Promise.resolve(Response.json(
        snapshotRequests === 1
          ? fileSnapshot("initial", "unstaged")
          : fileSnapshot("unstage-confirmed", "unstaged", 2),
      ));
    }
    const body = init?.body;
    if (!(body instanceof URLSearchParams)) throw new Error("Missing Git mutation body.");
    const action = body.get("action");
    if (action === null) throw new Error("Missing Git mutation action.");
    actions.push(action);
    return action === "stage" ? stageResponse.promise : unstageResponse.promise;
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const initial = waitForSnapshot(changes, "initial");
    changes.setViewActive(view, true);
    await initial;

    const stage = changes.updateFile("stage", "src/main.ts");
    assertEquals(projectedFileState(changes), { state: "staged", pending: true });
    const unstage = changes.updateFile("unstage", "src/main.ts");
    assertEquals(projectedFileState(changes), { state: "unstaged", pending: true });
    assertEquals(actions, ["stage"]);

    stageResponse.resolve(mutationAccepted(1));
    await stage;
    assertEquals(actions, ["stage", "unstage"]);

    const latestTruth = waitForProjectedFile(changes, "unstage-confirmed", "unstaged", false);
    unstageResponse.resolve(mutationAccepted(2));
    await unstage;
    await latestTruth;
    assertEquals(snapshotRequests, 2);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("rename identity survives Stage followed immediately by Unstage", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const stageResponse = Promise.withResolvers<Response>();
  const unstageResponse = Promise.withResolvers<Response>();
  const unstageStarted = Promise.withResolvers<void>();
  const mutations: { action: string | null; path: string | null; previousPath: string | null }[] =
    [];
  globalThis.fetch = (input, init) => {
    if (String(input).includes("git-snapshot")) {
      return Promise.resolve(Response.json(renameSnapshot("rename")));
    }
    const body = mutationBody(init);
    mutations.push({
      action: body.get("action"),
      path: body.get("path"),
      previousPath: body.get("previousPath"),
    });
    if (mutations.length === 2) {
      unstageStarted.resolve();
      return unstageResponse.promise;
    }
    return stageResponse.promise;
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const initial = waitForSnapshot(changes, "rename");
    changes.setViewActive(view, true);
    await initial;

    const stage = changes.updateFile("stage", "src/new.ts");
    const stagedRow = projectedRow(changes, "src/new.ts");
    assertEquals(stagedRow?.state, "staged");
    assertEquals(stagedRow?.pending, {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      requestPending: true,
    });
    if (stagedRow?.pending === undefined) throw new Error("Missing pending rename identity.");

    const unstage = changes.updateFile(
      "unstage",
      stagedRow.pending.path,
      stagedRow.pending.previousPath,
    );
    assertEquals(mutations, [{
      action: "stage",
      path: "src/new.ts",
      previousPath: null,
    }]);

    stageResponse.resolve(mutationAccepted(1));
    await unstageStarted.promise;
    assertEquals(mutations[1], {
      action: "unstage",
      path: "src/new.ts",
      previousPath: "src/old.ts",
    });

    unstageResponse.resolve(mutationAccepted(2));
    await Promise.all([stage, unstage]);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stale snapshots cannot retire a confirmed optimistic mutation", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const page = new SessionPageController("ready", []);
  let snapshotRequests = 0;
  globalThis.fetch = (input) => {
    if (!String(input).includes("git-snapshot")) {
      return Promise.resolve(mutationAccepted(1));
    }
    snapshotRequests++;
    const snapshot = snapshotRequests === 1
      ? fileSnapshot("initial", "unstaged")
      : snapshotRequests === 2
      ? { ...fileSnapshot("stale", "unstaged", 1), stale: true }
      : fileSnapshot("fresh", "staged", 1);
    return Promise.resolve(Response.json(snapshot));
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(page);
    const initial = waitForSnapshot(changes, "initial");
    changes.setViewActive(view, true);
    await initial;

    const stale = waitForProjectedFile(changes, "stale", "staged", true);
    await changes.updateFile("stage", "src/main.ts");
    await stale;

    const fresh = waitForProjectedFile(changes, "fresh", "staged", false);
    page.apply({ type: "git.snapshot.updated" });
    await fresh;
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("mutation workers skip obsolete same-file work and send other files concurrently", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const firstResponse = Promise.withResolvers<Response>();
  const latestResponse = Promise.withResolvers<Response>();
  const otherFileResponse = Promise.withResolvers<Response>();
  const latestStarted = Promise.withResolvers<void>();
  const otherFileStarted = Promise.withResolvers<void>();
  const mutations: { action: string | null; path: string | null }[] = [];
  let snapshotRequests = 0;
  globalThis.fetch = (input, init) => {
    if (String(input).includes("git-snapshot")) {
      snapshotRequests++;
      return Promise.resolve(Response.json(filesSnapshot(
        `queue-${snapshotRequests}`,
        ["src/a.ts", "src/b.ts"],
        snapshotRequests === 1 ? "unstaged" : "staged",
        snapshotRequests === 1 ? 0 : 3,
      )));
    }
    const body = mutationBody(init);
    const mutation = { action: body.get("action"), path: body.get("path") };
    mutations.push(mutation);
    if (mutation.path === "src/b.ts") {
      otherFileStarted.resolve();
      return otherFileResponse.promise;
    }
    if (mutations.filter((candidate) => candidate.path === "src/a.ts").length === 2) {
      latestStarted.resolve();
      return latestResponse.promise;
    }
    return firstResponse.promise;
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const initial = waitForSnapshot(changes, "queue-1");
    changes.setViewActive(view, true);
    await initial;

    const firstStage = changes.updateFile("stage", "src/a.ts");
    const obsoleteUnstage = changes.updateFile("unstage", "src/a.ts");
    const latestStage = changes.updateFile("stage", "src/a.ts");
    const otherFile = changes.updateFile("stage", "src/b.ts");
    await otherFileStarted.promise;
    assertEquals(mutations, [
      { action: "stage", path: "src/a.ts" },
      { action: "stage", path: "src/b.ts" },
    ]);

    firstResponse.resolve(mutationAccepted(1));
    await latestStarted.promise;
    assertEquals(mutations, [
      { action: "stage", path: "src/a.ts" },
      { action: "stage", path: "src/b.ts" },
      { action: "stage", path: "src/a.ts" },
    ]);

    latestResponse.resolve(mutationAccepted(3));
    otherFileResponse.resolve(mutationAccepted(2));
    await Promise.all([firstStage, obsoleteUnstage, latestStage, otherFile]);
    await waitForProjectedRows(changes, "queue-2", "staged", false, 2);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("empty snapshots preserve uncovered optimism and retire it once covered", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const mutationResponse = Promise.withResolvers<Response>();
  let snapshotRequests = 0;
  globalThis.fetch = (input) => {
    if (!String(input).includes("git-snapshot")) return mutationResponse.promise;
    snapshotRequests++;
    return Promise.resolve(Response.json(
      snapshotRequests === 1
        ? fileSnapshot("initial-file", "unstaged")
        : snapshotRequests === 2
        ? emptySnapshot("empty-during-mutation")
        : { ...emptySnapshot("empty-after-mutation"), mutationRevision: 1 },
    ));
  };

  try {
    const page = new SessionPageController("ready", []);
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(page);
    const initial = waitForSnapshot(changes, "initial-file");
    changes.setViewActive(view, true);
    await initial;

    const stage = changes.updateFile("stage", "src/main.ts");
    const pending = waitForProjectedFile(
      changes,
      "empty-during-mutation",
      "staged",
      true,
    );
    page.apply({ type: "git.snapshot.updated" });
    await pending;
    assertEquals(changes.projection.loaded?.snapshot.sections.staged.files, []);
    assertEquals(changes.projection.loaded?.snapshot.sections.unstaged.files, []);
    assertEquals(changes.projection.loaded?.changes.rows.length, 1);

    const settled = waitForProjectedRows(changes, "empty-after-mutation", "staged", false, 0);
    mutationResponse.resolve(mutationAccepted(1));
    await stage;
    await settled;
    assertEquals(changes.projection.loaded?.changes.rows.length, 0);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("mixed staged and unstaged truth retires covered optimism", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  let snapshotRequests = 0;
  globalThis.fetch = (input) => {
    if (!String(input).includes("git-snapshot")) {
      return Promise.resolve(mutationAccepted(1));
    }
    snapshotRequests++;
    return Promise.resolve(Response.json(
      snapshotRequests === 1
        ? fileSnapshot("mixed-initial", "unstaged")
        : mixedFileSnapshot("mixed-covered", 1),
    ));
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const initial = waitForSnapshot(changes, "mixed-initial");
    changes.setViewActive(view, true);
    await initial;

    await changes.updateFile("stage", "src/main.ts");
    await waitForSnapshot(changes, "mixed-covered");
    assertEquals(
      changes.projection.loaded?.changes.rows.map((row) => ({
        state: row.state,
        pending: row.pending !== undefined,
      })),
      [{ state: "unstaged", pending: false }, { state: "staged", pending: false }],
    );
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("snapshot revisions retire acknowledged files independently", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const page = new SessionPageController("ready", []);
  let snapshotRequests = 0;
  globalThis.fetch = (input, init) => {
    if (!String(input).includes("git-snapshot")) {
      const path = mutationBody(init).get("path");
      return Promise.resolve(mutationAccepted(path === "src/a.ts" ? 1 : 2));
    }
    snapshotRequests++;
    const snapshot = snapshotRequests === 1
      ? filesSnapshot("independent-initial", ["src/a.ts", "src/b.ts"])
      : snapshotRequests === 2
      ? splitFilesSnapshot("independent-first", 1)
      : filesSnapshot("independent-both", ["src/a.ts", "src/b.ts"], "staged", 2);
    return Promise.resolve(Response.json(snapshot));
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(page);
    const initial = waitForSnapshot(changes, "independent-initial");
    changes.setViewActive(view, true);
    await initial;

    await Promise.all([
      changes.updateFile("stage", "src/a.ts"),
      changes.updateFile("stage", "src/b.ts"),
    ]);
    await waitForSnapshot(changes, "independent-first");
    assertEquals(projectedRow(changes, "src/a.ts")?.pending, undefined);
    assertEquals(projectedRow(changes, "src/b.ts")?.pending !== undefined, true);

    const both = waitForProjectedRows(changes, "independent-both", "staged", false, 2);
    page.apply({ type: "git.snapshot.updated" });
    await both;
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an obsolete mutation error body cannot overwrite a newer file generation", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const bodyReadStarted = Promise.withResolvers<void>();
  const errorBody = Promise.withResolvers<{ error: string }>();
  const observedErrors: (string | undefined)[] = [];
  class DelayedErrorResponse extends Response {
    override json() {
      bodyReadStarted.resolve();
      return errorBody.promise;
    }
  }
  let mutationRequests = 0;
  let snapshotRequests = 0;
  globalThis.fetch = (input) => {
    if (String(input).includes("git-snapshot")) {
      snapshotRequests++;
      return Promise.resolve(
        Response.json(fileSnapshot(`snapshot-${snapshotRequests}`, "unstaged")),
      );
    }
    mutationRequests++;
    if (mutationRequests > 1) return Promise.resolve(mutationAccepted(1));
    return Promise.resolve(new DelayedErrorResponse(null, { status: 409 }));
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    changes.addEventListener(
      "change",
      () => observedErrors.push(changes.projection.operationError),
    );
    const initial = waitForSnapshot(changes, "snapshot-1");
    changes.setViewActive(view, true);
    await initial;

    const stage = changes.updateFile("stage", "src/main.ts");
    await bodyReadStarted.promise;
    const unstage = changes.updateFile("unstage", "src/main.ts");
    assertEquals(projectedFileState(changes), { state: "unstaged", pending: true });

    errorBody.resolve({ error: "Obsolete stage failure." });
    await Promise.all([stage, unstage]);

    assertEquals(mutationRequests, 2);
    assertEquals(observedErrors.includes("Obsolete stage failure."), false);
    assertEquals(changes.projection.operationError, undefined);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session changes pull full patches one bounded chunk at a time", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "sidebar" };
  const snapshotId = "a".repeat(64);
  const patch = [
    "diff --git a/src/main.ts b/src/main.ts",
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ -1 +1 @@",
    "-before",
    "+after 🌍",
    "",
  ].join("\n");
  const encoded = new TextEncoder().encode(patch);
  let chunkRequests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("git-snapshot")) {
      return Response.json({
        snapshotId,
        mutationRevision: 0,
        generatedAt: "snapshot-bulk",
        completeness: "complete",
        stale: false,
        truncated: false,
        sections: {
          staged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
          unstaged: {
            files: [{
              kind: "tracked",
              path: "src/main.ts",
              displayPath: "src/main.ts",
              status: "modified",
              diffState: "available",
            }],
            patch: "",
            fullPatchBytes: encoded.byteLength,
            truncated: false,
          },
        },
      });
    }
    const offset = Number(url.split("/").at(-1));
    const end = Math.min(encoded.byteLength, offset + 32);
    const bytes = encoded.subarray(offset, end);
    chunkRequests++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
    return Response.json({
      snapshotId,
      section: "unstaged",
      offset,
      bytes: encodeBase64(bytes),
      nextOffset: end,
      done: end === encoded.byteLength,
    });
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const loaded = waitForPatch(changes, patch);
    changes.setViewActive(view, true);
    await loaded;
    assertEquals(chunkRequests > 1, true);
    assertEquals(maxInFlight, 1);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session changes reuse current hydration and cancel it only for a newer snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const firstSnapshotId = "a".repeat(64);
  const secondSnapshotId = "b".repeat(64);
  const firstPatch = new TextEncoder().encode("first patch");
  const secondPatch = new TextEncoder().encode("second patch");
  let snapshotRequests = 0;
  let firstChunkRequests = 0;
  let firstChunkAborted = false;
  let activeChunkRequests = 0;
  let maxActiveChunkRequests = 0;

  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("git-snapshot")) {
      snapshotRequests++;
      const first = snapshotRequests < 3;
      return Promise.resolve(Response.json(bulkSnapshot(
        first ? firstSnapshotId : secondSnapshotId,
        first ? `first-${snapshotRequests}` : "second",
        first ? firstPatch.byteLength : secondPatch.byteLength,
      )));
    }

    const first = url.includes(firstSnapshotId);
    const snapshotId = first ? firstSnapshotId : secondSnapshotId;
    const bytes = first ? firstPatch : secondPatch;
    activeChunkRequests++;
    maxActiveChunkRequests = Math.max(maxActiveChunkRequests, activeChunkRequests);
    if (!first) {
      activeChunkRequests--;
      return Promise.resolve(patchChunkResponse(snapshotId, bytes));
    }

    firstChunkRequests++;
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        firstChunkAborted = true;
        activeChunkRequests--;
        reject(signal.reason);
      }, { once: true });
    });
  };

  try {
    const page = new SessionPageController("ready", []);
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(page);
    const firstLoaded = waitForSnapshot(changes, "first-1");
    changes.setViewActive(view, true);
    await firstLoaded;

    changes.setViewActive(view, false);
    await Promise.resolve();
    assertEquals(firstChunkAborted, false);

    const sameSnapshotLoaded = waitForSnapshot(changes, "first-2");
    changes.setViewActive(view, true);
    await sameSnapshotLoaded;
    assertEquals(firstChunkRequests, 1);

    const secondLoaded = waitForPatch(changes, "second patch");
    page.apply({ type: "git.snapshot.updated" });
    await secondLoaded;
    assertEquals(firstChunkAborted, true);
    assertEquals(maxActiveChunkRequests, 1);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("same-snapshot refresh at hydration completion retains the full patch", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const page = new SessionPageController("ready", []);
  const snapshotId = "c".repeat(64);
  const patch = new TextEncoder().encode("completed patch");
  let snapshotRequests = 0;
  let completionRefreshStarted = false;

  globalThis.fetch = (input) => {
    if (String(input).includes("git-snapshot")) {
      snapshotRequests++;
      return Promise.resolve(Response.json(bulkSnapshot(
        snapshotId,
        `completion-${snapshotRequests}`,
        patch.byteLength,
      )));
    }
    return Promise.resolve(patchChunkResponse(snapshotId, patch));
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(page);
    changes.addEventListener("change", () => {
      if (
        completionRefreshStarted ||
        changes.projection.loaded?.snapshot.sections.unstaged.patch !== "completed patch"
      ) return;
      completionRefreshStarted = true;
      page.apply({ type: "git.snapshot.updated" });
    });
    const stable = waitForHydratedSnapshot(changes, "completion-2", "completed patch");
    changes.setViewActive(view, true);
    await stable;
    assertEquals(snapshotRequests, 2);
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session changes expose bulk patch load failures", async () => {
  const originalFetch = globalThis.fetch;
  const lifetime = new AbortController();
  const view: SessionChangesViewOwner = { variant: "content" };
  const snapshotId = "b".repeat(64);
  globalThis.fetch = (input) => {
    if (!String(input).includes("git-snapshot")) {
      return Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
    }
    return Promise.resolve(Response.json({
      snapshotId,
      mutationRevision: 0,
      generatedAt: "snapshot-failure",
      completeness: "complete",
      stale: false,
      truncated: false,
      sections: {
        staged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
        unstaged: {
          files: [{
            kind: "tracked",
            path: "src/main.ts",
            displayPath: "src/main.ts",
            status: "modified",
            diffState: "available",
          }],
          patch: "preview",
          fullPatchBytes: 1024,
          truncated: false,
        },
      },
    }));
  };

  try {
    const changes = new SessionChangesResource("csrf-token", "session-id", lifetime.signal);
    changes.connect(new SessionPageController("ready", []));
    const failed = waitForRenderError(changes, "The full patch could not be loaded.");
    changes.setViewActive(view, true);
    await failed;
  } finally {
    lifetime.abort();
    globalThis.fetch = originalFetch;
  }
});

function waitForSnapshot(changes: SessionChangesResource, generatedAt: string): Promise<void> {
  return new Promise((resolve) => {
    const handleChange = () => {
      if (changes.projection.loaded?.snapshot.generatedAt !== generatedAt) return;
      changes.removeEventListener("change", handleChange);
      resolve();
    };
    changes.addEventListener("change", handleChange);
    handleChange();
  });
}

function waitForPatch(changes: SessionChangesResource, patch: string): Promise<void> {
  return new Promise((resolve) => {
    const handleChange = () => {
      if (changes.projection.loaded?.snapshot.sections.unstaged.patch !== patch) return;
      changes.removeEventListener("change", handleChange);
      resolve();
    };
    changes.addEventListener("change", handleChange);
    handleChange();
  });
}

function waitForRenderError(changes: SessionChangesResource, error: string): Promise<void> {
  return new Promise((resolve) => {
    const handleChange = () => {
      if (changes.projection.loaded?.renderError !== error) return;
      changes.removeEventListener("change", handleChange);
      resolve();
    };
    changes.addEventListener("change", handleChange);
    handleChange();
  });
}

function waitForHydratedSnapshot(
  changes: SessionChangesResource,
  generatedAt: string,
  patch: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      changes.removeEventListener("change", handleChange);
      reject(new Error("Timed out waiting for the hydrated snapshot."));
    }, 1_000);
    const handleChange = () => {
      const snapshot = changes.projection.loaded?.snapshot;
      if (snapshot?.generatedAt !== generatedAt || snapshot.sections.unstaged.patch !== patch) {
        return;
      }
      clearTimeout(timeout);
      changes.removeEventListener("change", handleChange);
      resolve();
    };
    changes.addEventListener("change", handleChange);
    handleChange();
  });
}

function waitForProjectedFile(
  changes: SessionChangesResource,
  generatedAt: string,
  state: "staged" | "unstaged",
  pending: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      changes.removeEventListener("change", handleChange);
      reject(new Error("Timed out waiting for the projected file state."));
    }, 1_000);
    const handleChange = () => {
      if (changes.projection.loaded?.snapshot.generatedAt !== generatedAt) return;
      const projected = projectedFileState(changes);
      if (projected.state !== state || projected.pending !== pending) return;
      clearTimeout(timeout);
      changes.removeEventListener("change", handleChange);
      resolve();
    };
    changes.addEventListener("change", handleChange);
    handleChange();
  });
}

function waitForProjectedRows(
  changes: SessionChangesResource,
  generatedAt: string,
  state: "staged" | "unstaged",
  pending: boolean,
  count: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      changes.removeEventListener("change", handleChange);
      reject(new Error("Timed out waiting for the projected file states."));
    }, 1_000);
    const handleChange = () => {
      const loaded = changes.projection.loaded;
      if (loaded?.snapshot.generatedAt !== generatedAt || loaded.changes.rows.length !== count) {
        return;
      }
      if (
        loaded.changes.rows.some((row) =>
          row.state !== state || (row.pending !== undefined) !== pending
        )
      ) return;
      clearTimeout(timeout);
      changes.removeEventListener("change", handleChange);
      resolve();
    };
    changes.addEventListener("change", handleChange);
    handleChange();
  });
}

function projectedFileState(changes: SessionChangesResource) {
  const row = projectedRow(changes, "src/main.ts");
  return { state: row?.state, pending: row?.pending !== undefined };
}

function projectedRow(changes: SessionChangesResource, path: string) {
  return changes.projection.loaded?.changes.rows.find((candidate) => candidate.file.path === path);
}

function mutationBody(init?: RequestInit): URLSearchParams {
  const body = init?.body;
  if (!(body instanceof URLSearchParams)) throw new Error("Missing Git mutation body.");
  return body;
}

function bulkSnapshot(snapshotId: string, generatedAt: string, fullPatchBytes: number) {
  return {
    snapshotId,
    mutationRevision: 0,
    generatedAt,
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: { files: [], patch: "", fullPatchBytes: 0, truncated: false },
      unstaged: {
        files: [{
          kind: "tracked",
          path: "src/main.ts",
          displayPath: "src/main.ts",
          status: "modified",
          diffState: "available",
        }],
        patch: "",
        fullPatchBytes,
        truncated: false,
      },
    },
  };
}

function patchChunkResponse(snapshotId: string, bytes: Uint8Array): Response {
  return Response.json({
    snapshotId,
    section: "unstaged",
    offset: 0,
    bytes: encodeBase64(bytes),
    nextOffset: bytes.byteLength,
    done: true,
  });
}

function emptySnapshot(generatedAt: string) {
  return {
    mutationRevision: 0,
    generatedAt,
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: { files: [], patch: "", truncated: false },
      unstaged: { files: [], patch: "", truncated: false },
    },
  };
}

function fileSnapshot(
  generatedAt: string,
  state: "staged" | "unstaged",
  mutationRevision = 0,
) {
  const file = {
    kind: "tracked" as const,
    path: "src/main.ts",
    displayPath: "src/main.ts",
    status: "modified" as const,
    diffState: "available" as const,
  };
  return {
    mutationRevision,
    generatedAt,
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: {
        files: state === "staged" ? [file] : [],
        patch: "",
        truncated: false,
      },
      unstaged: {
        files: state === "unstaged" ? [file] : [],
        patch: "",
        truncated: false,
      },
    },
  };
}

function filesSnapshot(
  generatedAt: string,
  paths: readonly string[],
  state: "staged" | "unstaged" = "unstaged",
  mutationRevision = 0,
) {
  const files = paths.map((path) => ({
    kind: "tracked" as const,
    path,
    displayPath: path,
    status: "modified" as const,
    diffState: "available" as const,
  }));
  return {
    mutationRevision,
    generatedAt,
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: { files: state === "staged" ? files : [], patch: "", truncated: false },
      unstaged: {
        files: state === "unstaged" ? files : [],
        patch: "",
        truncated: false,
      },
    },
  };
}

function mixedFileSnapshot(generatedAt: string, mutationRevision: number) {
  const file = fileSnapshot(generatedAt, "staged", mutationRevision);
  return {
    ...file,
    sections: {
      staged: file.sections.staged,
      unstaged: fileSnapshot(generatedAt, "unstaged", mutationRevision).sections.unstaged,
    },
  };
}

function splitFilesSnapshot(generatedAt: string, mutationRevision: number) {
  return {
    ...filesSnapshot(generatedAt, ["src/a.ts"], "staged", mutationRevision),
    sections: {
      staged: filesSnapshot(generatedAt, ["src/a.ts"], "staged").sections.staged,
      unstaged: filesSnapshot(generatedAt, ["src/b.ts"], "unstaged").sections.unstaged,
    },
  };
}

function renameSnapshot(generatedAt: string) {
  return {
    mutationRevision: 0,
    generatedAt,
    completeness: "complete",
    stale: false,
    truncated: false,
    sections: {
      staged: {
        files: [{
          kind: "tracked" as const,
          path: "src/new.ts",
          displayPath: "src/new.ts",
          status: "renamed" as const,
          diffState: "available" as const,
          previousPath: "src/old.ts",
          previousDisplayPath: "src/old.ts",
        }],
        patch: "",
        truncated: false,
      },
      unstaged: {
        files: [{
          kind: "tracked" as const,
          path: "src/new.ts",
          displayPath: "src/new.ts",
          status: "modified" as const,
          diffState: "available" as const,
        }],
        patch: "",
        truncated: false,
      },
    },
  };
}

function mutationAccepted(mutationRevision: number): Response {
  return Response.json({ mutationRevision });
}
