import { assert, assertEquals, assertMatch, assertNotEquals, assertNotMatch } from "@std/assert";
import type { UserId, WorkspaceId } from "@openorb/protocol/runner-api";

import {
  activate,
  createAppRouter,
  createAppServices,
  type MemoryStorage,
} from "@/test/workspace-test.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";

const DEFAULT_PROJECT_REF = "main";
const DEFAULT_PROJECT_BRANCH_PATTERN = "openorb/{session-name}-{short-session-id}";

const PASSWORD = "correct horse battery staple";
const FIRST_TOKEN = "github-test-token-f35b2611";
const SECOND_TOKEN = "github-replacement-token-9710dd2a";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert(value, "expected a Set-Cookie header");
  return value.split(";", 1)[0]!;
}

function csrfFrom(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert(match, "expected a CSRF form field");
  return match[1]!;
}

interface AuthenticatedClient {
  store: ReturnType<typeof activate>["workspace"];
  storage: MemoryStorage;
  server: Awaited<ReturnType<typeof createTestServer>>;
  cookie: string;
  userId: UserId;
  workspaceId: WorkspaceId;
}

async function createAuthenticatedClient(): Promise<AuthenticatedClient> {
  const { workspace: store, storage } = activate();
  const router = createAppRouter(createAppServices(store));
  const server = await createTestServer((request) => router.fetch(request));

  try {
    const setupUrl = new URL(routes.auth.setup.index.href(), server.baseUrl);
    const setupPage = await fetch(setupUrl);
    const setupResponse = await fetch(setupUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(setupPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await setupPage.text()),
        password: PASSWORD,
        confirmPassword: PASSWORD,
      }),
    });
    assertEquals(setupResponse.status, 303);

    const loginUrl = new URL(routes.auth.login.index.href(), server.baseUrl);
    const loginPage = await fetch(loginUrl);
    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookieFrom(loginPage) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await loginPage.text()),
        password: PASSWORD,
      }),
    });
    assertEquals(loginResponse.status, 303);
    const user = await store.verifyAdministratorPassword(PASSWORD);
    assert(user);
    assertNotEquals<string>(user.userId, user.workspaceId);
    return {
      store,
      storage,
      server,
      cookie: cookieFrom(loginResponse),
      userId: user.userId,
      workspaceId: user.workspaceId,
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function getPage(client: AuthenticatedClient, path: string): Promise<string> {
  const response = await fetch(new URL(path, client.server.baseUrl), {
    headers: { Cookie: client.cookie },
  });
  assertEquals(response.status, 200);
  return response.text();
}

async function submitForm(
  client: AuthenticatedClient,
  path: string,
  form: Record<string, string>,
): Promise<Response> {
  const html = await getPage(client, path);
  return fetch(new URL(path, client.server.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: client.cookie },
    body: new URLSearchParams({ _csrf: csrfFrom(html), ...form }),
  });
}

interface CredentialStorageRow {
  id: string;
  key: string;
  ciphertext: ArrayBuffer;
  keyVersion: number;
}

function readCredentialStorage(
  client: AuthenticatedClient,
): CredentialStorageRow {
  const record = client.storage.rows<CredentialStorageRow>(
    `
    SELECT g.id, s.key, s.ciphertext, s.keyVersion FROM git_credentials g
    JOIN encrypted_secrets s ON s.workspaceId = g.workspaceId AND s.key = g.secretKey
    WHERE g.workspaceId = ? AND g.host = 'github.com'
  `,
    client.workspaceId,
  )[0];
  assert(record);
  assert(record.ciphertext instanceof ArrayBuffer);
  return record;
}

Deno.test("configures GitHub, Git author, and project CRUD through protected browser forms", async () => {
  const client = await createAuthenticatedClient();
  const gitAuthorSettingsPath = routes.app.settings.gitAuthor.index.href();
  const githubSettingsPath = routes.app.settings.github.index.href();
  const projectsPath = routes.app.projects.index.href();
  try {
    const anonymous = await fetch(new URL(projectsPath, client.server.baseUrl), {
      redirect: "manual",
    });
    assertEquals(anonymous.status, 302);
    assertEquals(anonymous.headers.get("location"), "/");

    const emptyAuthorSettings = await getPage(client, gitAuthorSettingsPath);
    assertMatch(emptyAuthorSettings, /Git author/);
    assertMatch(emptyAuthorSettings, /Not configured/);
    assertNotMatch(emptyAuthorSettings, /GitHub credential/);
    const emptyGitHubSettings = await getPage(client, githubSettingsPath);
    assertMatch(emptyGitHubSettings, /GitHub credential/);
    assertMatch(emptyGitHubSettings, /Not configured/);
    assertNotMatch(emptyGitHubSettings, /id="git-author-heading"/);

    const authorResponse = await submitForm(client, gitAuthorSettingsPath, {
      intent: "save-git-author",
      authorName: "  OpenOrb Developer  ",
      authorEmail: "  developer@example.com  ",
    });
    assertEquals(authorResponse.status, 303);
    assertEquals(
      authorResponse.headers.get("location"),
      gitAuthorSettingsPath,
    );
    const author = await client.store.getGitAuthorConfiguration(client.userId);
    assert(author);
    assertEquals(author.authorName, "OpenOrb Developer");
    assertEquals(author.authorEmail, "developer@example.com");
    assertEquals(
      await activate(client.storage).workspace.getGitAuthorConfiguration(client.userId),
      author,
    );

    const invalidAuthor = await submitForm(client, gitAuthorSettingsPath, {
      intent: "save-git-author",
      authorName: "OpenOrb Developer",
      authorEmail: "not-an-email",
    });
    assertEquals(invalidAuthor.status, 400);
    assertMatch(await invalidAuthor.text(), /Expected valid email/);

    const saveToken = await submitForm(client, githubSettingsPath, {
      intent: "save-github-credential",
      token: FIRST_TOKEN,
    });
    assertEquals(saveToken.status, 303);
    assertEquals(saveToken.headers.get("location"), githubSettingsPath);
    const firstStorage = await readCredentialStorage(client);
    assertNotEquals(firstStorage.key, FIRST_TOKEN);
    assert(!client.storage.dump().includes(FIRST_TOKEN));
    assertEquals(await client.store.listSecrets(client.workspaceId), []);
    assertEquals(await client.store.listModelProviderCredentials(client.workspaceId), []);

    const configuredSettings = await getPage(client, githubSettingsPath);
    assertMatch(configuredSettings, /Configured · updated/);
    assertMatch(configuredSettings, /Replace token/);
    assertNotMatch(configuredSettings, new RegExp(FIRST_TOKEN));
    assertNotMatch(configuredSettings, /OPENORB_GITHUB_TOKEN_/);

    const replaceToken = await submitForm(client, githubSettingsPath, {
      intent: "save-github-credential",
      token: SECOND_TOKEN,
    });
    assertEquals(replaceToken.status, 303);
    const secondStorage = await readCredentialStorage(client);
    assertEquals(secondStorage.id, firstStorage.id);
    assertEquals(secondStorage.key, firstStorage.key);
    assertNotEquals(
      new Uint8Array(secondStorage.ciphertext),
      new Uint8Array(firstStorage.ciphertext),
    );
    assert(!client.storage.dump().includes(SECOND_TOKEN));
    assertEquals(await client.store.getGitHubToken(client.workspaceId), [SECOND_TOKEN, undefined]);
    assertNotMatch(await getPage(client, githubSettingsPath), new RegExp(SECOND_TOKEN));
    assertEquals(
      (await submitForm(client, githubSettingsPath, { intent: "delete-github-credential" })).status,
      303,
    );
    assertEquals(await client.store.getGitHubCredential(client.workspaceId), null);

    const missingCsrf = await fetch(new URL(projectsPath, client.server.baseUrl), {
      method: "POST",
      headers: { Cookie: client.cookie },
      body: new URLSearchParams({
        intent: "create-project",
        name: "OpenOrb",
        repository: "openorb-dev/openorb",
      }),
    });
    assertEquals(missingCsrf.status, 403);

    const publicProject = await submitForm(client, projectsPath, {
      intent: "create-project",
      name: "OpenOrb",
      repository: "openorb-dev/openorb",
    });
    assertEquals(publicProject.status, 303);
    assertEquals(publicProject.headers.get("location"), "/app/projects");
    let project = (await client.store.listProjects(client.workspaceId))[0]!;
    assertEquals(project.repositoryUrl, "https://github.com/openorb-dev/openorb.git");
    assertEquals(project.defaultRef, DEFAULT_PROJECT_REF);
    assertEquals(project.defaultBranchPattern, DEFAULT_PROJECT_BRANCH_PATTERN);

    const invalidRepository = await submitForm(client, projectsPath, {
      intent: "create-project",
      name: "Unsupported",
      repository: "git@gitlab.com:openorb-dev/openorb.git",
    });
    assertEquals(invalidRepository.status, 400);
    assertMatch(
      await invalidRepository.text(),
      /SSH and non-GitHub repositories are not supported/,
    );
    assertEquals((await client.store.listProjects(client.workspaceId)).length, 1);

    assertEquals(
      (await submitForm(client, githubSettingsPath, {
        intent: "save-github-credential",
        token: SECOND_TOKEN,
      })).status,
      303,
    );
    assert(await client.store.getGitHubCredential(client.workspaceId));

    const updateProject = await submitForm(client, projectsPath, {
      intent: "update-project",
      projectId: project.id,
      name: "OpenOrb private",
      repository: project.repositoryUrl,
    });
    assertEquals(updateProject.status, 303);
    project = (await client.store.listProjects(client.workspaceId))[0]!;
    assertEquals(project.name, "OpenOrb private");
    assertEquals(project.defaultRef, DEFAULT_PROJECT_REF);
    assertEquals(project.defaultBranchPattern, DEFAULT_PROJECT_BRANCH_PATTERN);

    const projectsHtml = await getPage(client, projectsPath);
    assertMatch(projectsHtml, /OpenOrb private/);
    assertNotMatch(projectsHtml, /Default ref/);
    assertNotMatch(projectsHtml, /Default branch pattern/);
    assertNotMatch(projectsHtml, /name="credentialId"/);
    assertNotMatch(projectsHtml, new RegExp(SECOND_TOKEN));

    assertEquals(
      (await submitForm(client, githubSettingsPath, { intent: "delete-github-credential" })).status,
      303,
    );
    assertEquals(await client.store.getGitHubCredential(client.workspaceId), null);
    assertEquals(
      client.storage.rows(
        "SELECT id FROM git_credentials WHERE workspaceId = ?",
        client.workspaceId,
      ),
      [],
    );

    const sessionId = crypto.randomUUID();
    assertEquals(
      await client.store.reconcileSessionManifestEntries(client.workspaceId, [{
        id: sessionId,
        projectId: project.id,
        createdAt: new Date().toISOString(),
        initialPromptPreview: "Project deletion reference",
      }]),
      [{ acceptedSessionIds: [sessionId], tombstonedSessionIds: [], rejected: [] }, undefined],
    );
    const inUseDeletion = await submitForm(client, projectsPath, {
      intent: "delete-project",
      projectId: project.id,
    });
    assertEquals(inUseDeletion.status, 409);
    assertMatch(await inUseDeletion.text(), /used by a session and cannot be deleted/);
    assert(await client.store.getProject(client.workspaceId, project.id));
    assertEquals(
      await client.store.deleteSessionCatalogEntry(
        client.workspaceId,
        sessionId,
        new Date().toISOString(),
      ),
      ["deleted", undefined],
    );

    assertEquals(
      (await submitForm(client, projectsPath, {
        intent: "delete-project",
        projectId: project.id,
      })).status,
      303,
    );
    assertEquals(await client.store.listProjects(client.workspaceId), []);
    assertMatch(await getPage(client, projectsPath), /No projects configured/);
  } finally {
    await client.server.close();
  }
});
