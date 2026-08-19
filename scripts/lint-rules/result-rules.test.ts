/// <reference lib="deno.unstable" />

import { assertEquals } from "@std/assert";

import plugin from "@/scripts/lint-plugin.ts";

const RESULT_RULE = "openorb/require-result-handling";
const THROW_RULE = "openorb/no-generic-error-throw";
const CATCH_RULE = "openorb/no-catch";
const FILENAME = "packages/runner/src/example.ts";

function diagnostics(source: string, rule: string = RESULT_RULE) {
  return Deno.lint.runPlugin(plugin, FILENAME, source).filter(({ id }) => id === rule);
}

Deno.test("Results are immediately destructured and guarded by a terminating failure branch", () => {
  const source = `
import { err, type Result } from "@openorb/result";
declare function getUser(id: string): Promise<Result<{ name: string }, Error>>;
export async function load(id: string): Promise<Result<string, Error>> {
  const [user, error] = await getUser(id);
  if (error !== undefined) {
    return err(error);
  }
  return [user.name, undefined];
}
`;

  assertEquals(diagnostics(source), []);
});

Deno.test("an unused success value may be omitted from the immediate destructure", () => {
  const source = `
import { err, tryAsync } from "@openorb/result";
async function persist(): Promise<void> {}
async function save() {
  const [, error] = await tryAsync(persist(), cause => new TypeError("failed", { cause }));
  if (error !== undefined) return err(error);
  return [undefined, undefined] as const;
}
`;

  assertEquals(diagnostics(source), []);
});

Deno.test("a Promise of a Result may be retained until it is awaited", () => {
  const source = `
import { err, type Result } from "@openorb/result";
declare function getUser(id: string): Promise<Result<string, Error>>;
async function load() {
  const pending = getUser("1");
  const [user, error] = await pending;
  if (error !== undefined) return err(error);
  return [user, undefined] as const;
}
`;

  assertEquals(diagnostics(source), []);
});

Deno.test("Result containers cannot be retained or indexed", () => {
  const retained = `
import type { Result } from "@openorb/result";
declare function getUser(id: string): Promise<Result<string, Error>>;
const result = await getUser("1");
`;
  assertEquals(
    diagnostics(retained).map(({ message }) => message),
    ["Destructure a Result immediately instead of retaining its container."],
  );

  const indexed = `
import { trySync } from "@openorb/result";
const result = trySync(() => "user", cause => new TypeError("failed", { cause }));
console.log(result[0]);
`;
  assertEquals(
    diagnostics(indexed).map(({ message }) => message),
    [
      "Destructure a Result immediately instead of retaining its container.",
      "Destructure Results; do not access tuple slots by index.",
    ],
  );
});

Deno.test("Result aggregates cannot be retained or indexed", () => {
  const source = `
import type { Result } from "@openorb/result";
declare function getUser(id: string): Promise<Result<string, Error>>;
const results = await Promise.all([getUser("1"), getUser("2")]);
console.log(results.find(([, error]) => error !== undefined)?.[1]);
`;

  assertEquals(
    diagnostics(source).map(({ message }) => message),
    [
      "Do not retain an aggregate containing Results; destructure each Result when it settles.",
      "Destructure Results; do not access tuple slots by index.",
    ],
  );
});

Deno.test("first-party imported Result producers remain known across module boundaries", () => {
  const source = `
import { readRunnerIdentity as readIdentity } from "@/src/identity.ts";
const retained = await readIdentity("/runner");
console.log(retained[0]);
`;

  assertEquals(
    diagnostics(source).map(({ message }) => message),
    [
      "Destructure a Result immediately instead of retaining its container.",
      "Destructure Results; do not access tuple slots by index.",
    ],
  );
});

Deno.test("known Result parameters and method calls cannot be indexed or retained", () => {
  const source = `
import type { Result as Outcome } from "@openorb/result";
interface Users {
  getUser(id: string): Promise<Outcome<string, Error>>;
}
declare const users: Users;
function value(result: Outcome<string, Error>) {
  return result[0];
}
const retained = await users.getUser("1");
`;

  assertEquals(
    diagnostics(source).map(({ message }) => message),
    [
      "Destructure Results; do not access tuple slots by index.",
      "Destructure a Result immediately instead of retaining its container.",
    ],
  );
});

Deno.test("ordinary tuples are not treated as Results", () => {
  const source = `
declare function coordinates(): readonly [number, number];
const point = coordinates();
console.log(point[0]);
`;

  assertEquals(diagnostics(source), []);
});

Deno.test("a Result error guard must be the next statement", () => {
  const source = `
import { err, tryAsync } from "@openorb/result";
const [user, error] = await tryAsync(Promise.resolve("user"), cause => new Error(String(cause)));
doSomethingElse();
if (error !== undefined) return err(error);
console.log(user);
`;

  assertEquals(
    diagnostics(source).map(({ message }) => message),
    ["Guard `error` against undefined in the statement immediately after this Result."],
  );
});

Deno.test("a Result failure branch must terminate", () => {
  const source = `
import { tryAsync } from "@openorb/result";
const [user, error] = await tryAsync(Promise.resolve("user"), cause => new Error(String(cause)));
if (error !== undefined) {
  console.error(error);
}
console.log(user);
`;

  assertEquals(
    diagnostics(source).map(({ message }) => message),
    ["The `error` failure branch must terminate control flow on every path."],
  );
});

Deno.test("nested failure paths are accepted only when every path terminates", () => {
  const accepted = `
import { err, trySync } from "@openorb/result";
function load(verbose: boolean) {
  const [user, error] = trySync(() => "user", cause => new TypeError("failed", { cause }));
  if (error !== undefined) {
    if (verbose) {
      console.error(error);
      return err(error);
    } else {
      return err(error);
    }
  }
  return user;
}
`;
  assertEquals(diagnostics(accepted), []);

  const rejected = accepted.replace(
    "return err(error);\n    } else",
    "console.error(error);\n    } else",
  );
  assertEquals(
    diagnostics(rejected).map(({ message }) => message),
    ["The `error` failure branch must terminate control flow on every path."],
  );
});

Deno.test("continue terminates a Result failure path", () => {
  const source = `
import { trySync } from "@openorb/result";
for (const input of ["first", "second"]) {
  const [value, error] = trySync(() => input, cause => new Error(String(cause)));
  if (error !== undefined) {
    continue;
  }
  console.log(value);
}
`;

  assertEquals(diagnostics(source), []);
});

Deno.test("a Result value cannot be used inside its failure branch", () => {
  const source = `
import { err, trySync } from "@openorb/result";
function load() {
  const [user, error] = trySync(() => "user", cause => new TypeError("failed", { cause }));
  if (error !== undefined) {
    console.error(user);
    return err(error);
  }
  return user;
}
`;

  assertEquals(
    diagnostics(source).map(({ message }) => message),
    ["Do not use `user` while `error` is present."],
  );
});

Deno.test("the success-first guard form is accepted when the failure branch terminates", () => {
  const source = `
import { err, trySync } from "@openorb/result";
function load() {
  const [user, error] = trySync(() => "user", cause => new TypeError("failed", { cause }));
  if (error === undefined) {
    console.log(user);
  } else {
    return err(error);
  }
  return [user, undefined] as const;
}
`;

  assertEquals(diagnostics(source), []);
});

Deno.test("application code cannot throw generic Error or catch exceptions", () => {
  assertEquals(
    diagnostics("throw new Error('failed');", THROW_RULE).map(({ id }) => id),
    [THROW_RULE],
  );
  assertEquals(
    diagnostics("throw Error('failed');", THROW_RULE).map(({ id }) => id),
    [THROW_RULE],
  );
  assertEquals(
    diagnostics("try { work(); } catch { recover(); }", CATCH_RULE).map(({ id }) => id),
    [CATCH_RULE],
  );
  assertEquals(diagnostics("throw new DomainError('failed');", THROW_RULE), []);
  assertEquals(diagnostics("try { work(); } finally { cleanup(); }", CATCH_RULE), []);
});

Deno.test("application-created generic exceptions remain forbidden inside a Result boundary", () => {
  const source = `
import { trySync as attempt } from "@openorb/result";
const [value, error] = attempt(
  () => { throw new Error("boundary failure"); },
  cause => new DomainError("operation failed", { cause }),
);
if (error !== undefined) return error;
console.log(value);
`;

  assertEquals(
    diagnostics(source, THROW_RULE).map(({ id }) => id),
    [THROW_RULE],
  );
});

Deno.test("Result utility and test code may implement or assert exception boundaries", () => {
  const source = "try { work(); } catch { throw new Error('failed'); }";
  assertEquals(
    Deno.lint.runPlugin(plugin, "packages/result/src/index.ts", source).filter(({ id }) =>
      id === CATCH_RULE || id === THROW_RULE
    ),
    [],
  );
  assertEquals(
    Deno.lint.runPlugin(plugin, "packages/runner/test/example.test.ts", source).filter(({ id }) =>
      id === CATCH_RULE || id === THROW_RULE
    ),
    [],
  );
  assertEquals(
    Deno.lint.runPlugin(plugin, "packages/gateway/app/example.test.ts", source).filter(({ id }) =>
      id === CATCH_RULE || id === THROW_RULE
    ),
    [],
  );
});
