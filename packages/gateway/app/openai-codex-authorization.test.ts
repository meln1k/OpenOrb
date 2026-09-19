import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { assert, assertEquals } from "@std/assert";

import { OPENAI_CODEX_PROVIDER_ID } from "@/app/model-provider-catalog.ts";
import { createOpenAICodexAuthorizationService } from "@/app/openai-codex-authorization.ts";
import { createTestStore } from "@/test/postgres-test.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface LoginCall {
  readonly completion: Deferred<OAuthCredential>;
  readonly signal: AbortSignal;
}

interface ControllableOAuth {
  readonly oauth: OAuthAuth;
  readonly logins: LoginCall[];
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function credential(name: string, expires = Date.now() + 3_600_000): OAuthCredential {
  return {
    type: "oauth",
    access: `${name}-access`,
    refresh: `${name}-refresh`,
    expires,
  };
}

function controllableOAuth(): ControllableOAuth {
  const logins: LoginCall[] = [];
  const oauth: OAuthAuth = {
    name: "Test OpenAI Codex OAuth",
    async login(interaction: ProviderAuthInteraction) {
      assertEquals(
        await interaction.prompt({
          type: "select",
          message: "Choose login",
          options: [{ id: "device_code", label: "Device code" }],
        }),
        "device_code",
      );
      const completion = deferred<OAuthCredential>();
      const call = { completion, signal: interaction.signal };
      logins.push(call);
      interaction.notify({
        type: "device_code",
        userCode: `CODE-${logins.length}`,
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 2,
      });
      return await completion.promise;
    },
    refresh: (current) => Promise.resolve(current),
    toAuth: (current) => Promise.resolve({ apiKey: current.access }),
  };
  return { oauth, logins };
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected authorization state.");
}

Deno.test("a newer Pi login discards the stale completion and owns browser status", async () => {
  const store = await createTestStore();
  assert(await store.createAdministrator("authorization race password"));
  const administrator = await store.verifyAdministratorPassword("authorization race password");
  assert(administrator);
  const { oauth, logins } = controllableOAuth();
  const service = createOpenAICodexAuthorizationService(store, {
    oauth,
    revoke: () => Promise.resolve(),
  });

  try {
    const first = await service.start(administrator.workspaceId);
    const second = await service.start(administrator.workspaceId);
    assert(logins[0]?.signal.aborted);
    assertEquals(service.status(administrator.workspaceId, first.id), { status: "missing" });
    assertEquals(service.status(administrator.workspaceId, second.id), {
      status: "pending",
      authorization: second,
    });
    assertEquals(service.status(administrator.workspaceId, second.id), {
      status: "pending",
      authorization: second,
    });
    assertEquals(logins.length, 2);

    logins[0]!.completion.resolve(credential("stale"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      await store.getModelProviderCredential(administrator.workspaceId, OPENAI_CODEX_PROVIDER_ID),
      null,
    );

    logins[1]!.completion.resolve(credential("current"));
    await waitFor(async () =>
      (await store.getModelProviderCredential(
        administrator.workspaceId,
        OPENAI_CODEX_PROVIDER_ID,
      )) !== null
    );
    assertEquals(service.status(administrator.workspaceId, second.id), { status: "complete" });
    assertEquals(await service.resolveAccessToken(administrator.workspaceId), "current-access");
  } finally {
    await store.close();
  }
});

Deno.test("disconnect aborts an outstanding Pi login before deleting Workspace state", async () => {
  const store = await createTestStore();
  assert(await store.createAdministrator("authorization disconnect password"));
  const administrator = await store.verifyAdministratorPassword(
    "authorization disconnect password",
  );
  assert(administrator);
  const { oauth, logins } = controllableOAuth();
  const service = createOpenAICodexAuthorizationService(store, {
    oauth,
    revoke: () => Promise.resolve(),
  });

  try {
    const authorization = await service.start(administrator.workspaceId);
    assertEquals(await service.disconnect(administrator.workspaceId), { status: "not-found" });
    assert(logins[0]?.signal.aborted);
    logins[0]!.completion.resolve(credential("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(service.status(administrator.workspaceId, authorization.id), {
      status: "missing",
    });
    assertEquals(
      await store.getModelProviderCredential(administrator.workspaceId, OPENAI_CODEX_PROVIDER_ID),
      null,
    );
  } finally {
    await store.close();
  }
});

Deno.test("refresh and disconnect serialize around the credential that is revoked", async () => {
  const store = await createTestStore();
  assert(await store.createAdministrator("authorization refresh password"));
  const administrator = await store.verifyAdministratorPassword("authorization refresh password");
  assert(administrator);
  const expired = credential("expired", 1_800_000_000_000);
  const rotated = credential("rotated", 1_800_003_600_000);
  const refreshStarted = deferred<void>();
  const refreshCompletion = deferred<OAuthCredential>();
  const revoked: OAuthCredential[] = [];
  const oauth: OAuthAuth = {
    name: "Test OpenAI Codex OAuth",
    login: () => Promise.reject(new Error("not used")),
    refresh(current) {
      assertEquals(current, expired);
      refreshStarted.resolve();
      return refreshCompletion.promise;
    },
    toAuth: (current) => Promise.resolve({ apiKey: current.access }),
  };
  const service = createOpenAICodexAuthorizationService(store, {
    oauth,
    revoke(current) {
      revoked.push(current);
      return Promise.resolve();
    },
  });

  try {
    await store.saveModelProviderOAuthCredential(
      administrator.workspaceId,
      OPENAI_CODEX_PROVIDER_ID,
      expired,
    );
    const resolving = service.resolveAccessToken(administrator.workspaceId, 1_800_000_000_000);
    await refreshStarted.promise;
    const disconnecting = service.disconnect(administrator.workspaceId);
    refreshCompletion.resolve(rotated);

    assertEquals(await resolving, rotated.access);
    assertEquals(await disconnecting, { status: "deleted" });
    assertEquals(revoked, [rotated]);
    assertEquals(
      await store.getModelProviderCredential(administrator.workspaceId, OPENAI_CODEX_PROVIDER_ID),
      null,
    );
  } finally {
    await store.close();
  }
});
