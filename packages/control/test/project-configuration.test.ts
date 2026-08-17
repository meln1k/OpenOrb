import { assert, assertEquals, assertMatch, assertNotEquals, assertNotMatch } from "@std/assert";

import {
  DEFAULT_PROJECT_BRANCH_PATTERN,
  DEFAULT_PROJECT_REF,
} from "@/app/data/project-repository.ts";
import { createAppServices } from "@/app/middleware/services.ts";
import { createAppRouter } from "@/app/router.ts";
import { routes } from "@/app/routes.ts";
import { createTestServer } from "@/test/http-test-server.ts";
import { createTestStore } from "@/test/postgres-test.ts";

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
  store: Awaited<ReturnType<typeof createTestStore>>;
  server: Awaited<ReturnType<typeof createTestServer>>;
  cookie: string;
  userId: string;
}

async function createAuthenticatedClient(): Promise<AuthenticatedClient> {
  const store = await createTestStore();
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
    return { store, server, cookie: cookieFrom(loginResponse), userId: user.id };
  } catch (error) {
    await server.close();
    await store.close();
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
  credential_id: string;
  secret_row_id: string;
  secret_key: string;
  secret_purpose: string;
  ciphertext: string;
}

async function readCredentialStorage(
  client: AuthenticatedClient,
): Promise<CredentialStorageRow> {
  const result = await client.store.pool.query<CredentialStorageRow>(
    `select gc.id as credential_id,
            gc.encrypted_secret_id as secret_row_id,
            es.key as secret_key,
            es.purpose as secret_purpose,
            es.ciphertext
       from git_credentials gc
       join encrypted_secrets es on es.id = gc.encrypted_secret_id`,
  );
  assertEquals(result.rows.length, 1);
  return result.rows[0]!;
}

Deno.test("configures GitHub, Git author, and project CRUD through protected browser forms", async () => {
  const client = await createAuthenticatedClient();
  const settingsPath = routes.app.settings.index.href();
  const projectsPath = routes.app.projects.index.href();
  try {
    const anonymous = await fetch(new URL(projectsPath, client.server.baseUrl));
    assertEquals(anonymous.status, 401);

    const emptySettings = await getPage(client, settingsPath);
    assertMatch(emptySettings, /GitHub credential/);
    assertMatch(emptySettings, /Git author/);
    assertMatch(emptySettings, /Not configured/);

    const authorResponse = await submitForm(client, settingsPath, {
      intent: "save-git-author",
      authorName: "  OpenOrb Developer  ",
      authorEmail: "  developer@example.com  ",
    });
    assertEquals(authorResponse.status, 303);
    assertEquals(
      authorResponse.headers.get("location"),
      "/app/settings?tab=git-author#git-author",
    );
    const author = await client.store.getGitAuthorConfiguration(client.userId);
    assert(author);
    assertEquals(author.authorName, "OpenOrb Developer");
    assertEquals(author.authorEmail, "developer@example.com");
    assertEquals(
      (await client.store.pool.query("select user_id from git_author_configuration")).rows[0]
        ?.user_id,
      client.userId,
    );

    const invalidAuthor = await submitForm(client, settingsPath, {
      intent: "save-git-author",
      authorName: "OpenOrb Developer",
      authorEmail: "not-an-email",
    });
    assertEquals(invalidAuthor.status, 400);
    assertMatch(await invalidAuthor.text(), /Expected valid email/);

    const saveToken = await submitForm(client, settingsPath, {
      intent: "save-github-credential",
      token: FIRST_TOKEN,
    });
    assertEquals(saveToken.status, 303);
    assertEquals(saveToken.headers.get("location"), "/app/settings?tab=github#github");
    const firstStorage = await readCredentialStorage(client);
    assertMatch(firstStorage.secret_key, /^OPENORB_GITHUB_TOKEN_[0-9A-F]{32}$/);
    assertEquals(firstStorage.secret_purpose, "git-credential");
    assert(!firstStorage.ciphertext.includes(FIRST_TOKEN));
    assertEquals(await client.store.listSecrets(client.userId), []);

    const configuredSettings = await getPage(client, settingsPath);
    assertMatch(configuredSettings, /Configured · updated/);
    assertMatch(configuredSettings, /Replace token/);
    assertNotMatch(configuredSettings, new RegExp(FIRST_TOKEN));
    assertNotMatch(configuredSettings, /OPENORB_GITHUB_TOKEN_/);

    const replaceToken = await submitForm(client, settingsPath, {
      intent: "save-github-credential",
      token: SECOND_TOKEN,
    });
    assertEquals(replaceToken.status, 303);
    const secondStorage = await readCredentialStorage(client);
    assertEquals(secondStorage.credential_id, firstStorage.credential_id);
    assertEquals(secondStorage.secret_row_id, firstStorage.secret_row_id);
    assertNotEquals(secondStorage.ciphertext, firstStorage.ciphertext);
    assert(!secondStorage.ciphertext.includes(SECOND_TOKEN));
    assertNotMatch(await getPage(client, settingsPath), new RegExp(SECOND_TOKEN));
    assertEquals(
      (await submitForm(client, settingsPath, { intent: "delete-github-credential" })).status,
      303,
    );
    assertEquals(await client.store.getGitHubCredential(client.userId), null);

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
    let project = (await client.store.listProjects(client.userId))[0]!;
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
    assertEquals((await client.store.listProjects(client.userId)).length, 1);

    assertEquals(
      (await submitForm(client, settingsPath, {
        intent: "save-github-credential",
        token: SECOND_TOKEN,
      })).status,
      303,
    );
    assert(await client.store.getGitHubCredential(client.userId));

    const updateProject = await submitForm(client, projectsPath, {
      intent: "update-project",
      projectId: project.id,
      name: "OpenOrb private",
      repository: project.repositoryUrl,
    });
    assertEquals(updateProject.status, 303);
    project = (await client.store.listProjects(client.userId))[0]!;
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
      (await submitForm(client, settingsPath, { intent: "delete-github-credential" })).status,
      303,
    );
    assertEquals(await client.store.getGitHubCredential(client.userId), null);
    assertEquals(
      (await client.store.pool.query("select count(*)::integer as count from encrypted_secrets"))
        .rows[0]?.count,
      0,
    );

    await client.store.pool.query(
      `create table project_delete_test_references (
        project_id uuid primary key references projects(id) on delete restrict
      )`,
    );
    try {
      await client.store.pool.query(
        "insert into project_delete_test_references (project_id) values ($1)",
        [project.id],
      );
      const inUseDeletion = await submitForm(client, projectsPath, {
        intent: "delete-project",
        projectId: project.id,
      });
      assertEquals(inUseDeletion.status, 409);
      assertMatch(await inUseDeletion.text(), /used by a session and cannot be deleted/);
      assert(await client.store.getProject(client.userId, project.id));
    } finally {
      await client.store.pool.query("drop table project_delete_test_references");
    }

    assertEquals(
      (await submitForm(client, projectsPath, {
        intent: "delete-project",
        projectId: project.id,
      })).status,
      303,
    );
    assertEquals(await client.store.listProjects(client.userId), []);
    assertMatch(await getPage(client, projectsPath), /No projects configured/);
  } finally {
    await client.server.close();
    await client.store.close();
  }
});

Deno.test("the ticket down migration removes the encrypted GitHub token", async () => {
  const store = await createTestStore();
  const connection = await store.pool.connect();
  try {
    assert(await store.createAdministrator(PASSWORD));
    const user = await store.verifyAdministratorPassword(PASSWORD);
    assert(user);
    await store.saveGitHubCredential(user.id, FIRST_TOKEN);
    const downSql = await Deno.readTextFile(
      new URL(
        "../db/migrations/20250809000000_create_git_configuration_and_projects/down.sql",
        import.meta.url,
      ),
    );
    const sessionCatalogDownSql = await Deno.readTextFile(
      new URL(
        "../db/migrations/20250814000000_create_session_catalog/down.sql",
        import.meta.url,
      ),
    );

    await connection.query("begin");
    await connection.query(sessionCatalogDownSql);
    await connection.query(downSql);
    assertEquals(
      (await connection.query(
        "select count(*)::integer as count from encrypted_secrets where key like 'OPENORB_GITHUB_TOKEN_%'",
      )).rows[0]?.count,
      0,
    );
    assertEquals(
      (await connection.query(
        "select to_regclass('git_credentials') as git_credentials, to_regclass('projects') as projects",
      )).rows[0],
      { git_credentials: null, projects: null },
    );
  } finally {
    await connection.query("rollback");
    connection.release();
    await store.close();
  }
});
