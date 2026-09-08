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

function bulkSnapshot(snapshotId: string, generatedAt: string, fullPatchBytes: number) {
  return {
    snapshotId,
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
