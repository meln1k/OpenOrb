import { assertEquals } from "@std/assert";

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
