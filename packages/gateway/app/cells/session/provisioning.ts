import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { EnvironmentCredentials } from "@openorb/environments";
import {
  type CheckoutState,
  MAX_SESSION_ISSUES,
  MAX_SESSION_OUTPUT_BYTES,
  type SessionIssue,
  type SessionIssueCategory,
  type SessionProvisioningStage,
  type SessionRecoveryAction,
} from "./view.ts";

// Project work runs in the guest over ExecutionEnv for every Agent Environment Provider
// (ADR 0006). Their outcomes are transcript entries (ADR 0008); failures are also Session issues.

const WORKSPACE = "/workspace";
/** A command's output is kept up to this size, its end first: failures are reported last. */
const MAX_CAPTURED_OUTPUT_BYTES = MAX_SESSION_OUTPUT_BYTES;
const OUTPUT_TRUNCATED_MESSAGE = "[Earlier output was truncated.]\n";
/** More than the longest secret's UTF-8 size. */
const REDACTION_SLACK = 16 * 1024;
const encoder = new TextEncoder();

/** The transcript entry kind for the outcome of a project command: clone, setup, or resume. */
export const SETUP_ENTRY_KIND = "openorb.setup";

/** What a project command did, as its transcript entry shows it. */
export interface SetupOutput {
  readonly step: "clone" | "setup" | "resume";
  readonly exitCode: number;
  /** Redacted, interleaved stdout and stderr; the end of it when long. */
  readonly output: string;
}

export interface CheckoutDefinition {
  readonly repositoryUrl: string;
  readonly ref: string;
  readonly branchName: string;
}

export interface ProvisioningReporter {
  readonly stage: (stage: SessionProvisioningStage) => void;
  /** Records a project command's outcome in the transcript. */
  readonly output: (output: SetupOutput) => Promise<void>;
  /** The session branch is checked out; `.agents/setup` has not run yet. */
  readonly checkedOut?: (baseCommit: string) => void;
}

export interface CheckoutResult {
  readonly checkoutState: CheckoutState;
  readonly baseCommit?: string;
  readonly issues: readonly SessionIssue[];
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  /** Redacted stdout and stderr, interleaved. */
  readonly output: string;
}

export class ProvisioningFailure extends Error {
  readonly issue: SessionIssue;

  constructor(issue: SessionIssue) {
    super(issue.message);
    this.name = "ProvisioningFailure";
    this.issue = issue;
  }
}

/** Guest commands whose output is bounded and redacted before anyone sees it. */
class GuestCommands {
  constructor(
    private readonly env: ExecutionEnv,
    private readonly secrets: readonly string[],
    private readonly context: Context,
  ) {}

  async run(argv: readonly string[]): Promise<CommandOutput> {
    const stdout = new OutputTail();
    const output = new OutputTail();
    const result = await this.env.exec(
      argv,
      {
        cwd: WORKSPACE,
        onOutput: (text, _context, info) => {
          const clean = sanitizeOutput(text);
          if (info.stream === "stdout") stdout.push(clean);
          output.push(clean);
        },
      },
      this.context,
    );
    if (!result.ok) output.push(`\n${result.error.message}`);
    return {
      exitCode: result.ok ? result.value.exitCode : -1,
      stdout: stdout.text(this.#redact),
      output: output.text(this.#redact),
    };
  }

  diagnostics(output: CommandOutput): string | undefined {
    return output.output.trim() || undefined;
  }

  readonly #redact = (text: string): string => {
    let redacted = text;
    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
  };
}

/**
 * The end of a command's output. Redaction runs on the whole retained text, which keeps enough
 * beyond the limit that a secret cut at its start is dropped by the final truncation.
 */
class OutputTail {
  readonly #chunks: { readonly text: string; readonly bytes: number }[] = [];
  #bytes = 0;

  push(text: string): void {
    const bytes = encoder.encode(text).length;
    this.#chunks.push({ text, bytes });
    this.#bytes += bytes;
    while (this.#bytes - this.#chunks[0]!.bytes >= MAX_CAPTURED_OUTPUT_BYTES + REDACTION_SLACK) {
      this.#bytes -= this.#chunks.shift()!.bytes;
    }
  }

  text(redact: (text: string) => string): string {
    return keepTail(redact(this.#chunks.map((chunk) => chunk.text).join("")));
  }
}

/**
 * Clones the repository into an empty /workspace, creates the session branch, and runs
 * `.agents/setup`. A failed clone or setup is a warning: the stored prompt still runs so Pi can
 * diagnose or repair the project. Infrastructure failures throw `ProvisioningFailure`.
 */
export async function provisionCheckout(
  env: ExecutionEnv,
  definition: CheckoutDefinition,
  reporter: ProvisioningReporter,
  secrets: readonly string[],
  context: Context,
): Promise<CheckoutResult> {
  const commands = new GuestCommands(env, secrets, context);
  const issues: SessionIssue[] = [];
  await createWorkspace(env, context);
  const cleared = await commands.run(["/usr/bin/find", WORKSPACE, "-mindepth", "1", "-delete"]);
  if (cleared.exitCode !== 0) {
    throw new ProvisioningFailure(
      sessionIssue({
        category: "environment-storage",
        severity: "failure",
        message: "The session workspace could not be prepared for cloning.",
        diagnostics: commands.diagnostics(cleared),
        recovery: "retry-provisioning",
      }),
    );
  }
  reporter.stage("cloning");
  const clone = await commands.run([
    "/usr/bin/git",
    "clone",
    "--no-recurse-submodules",
    "--branch",
    definition.ref,
    "--single-branch",
    definition.repositoryUrl,
    ".",
  ]);
  if (clone.exitCode !== 0) {
    await reporter.output({ step: "clone", exitCode: clone.exitCode, output: clone.output });
    const category = gitFailureCategory(clone.output);
    issues.push(
      sessionIssue({
        category,
        severity: "warning",
        message:
          category === "github-authentication"
            ? "GitHub authentication failed while cloning. The checkout is unavailable, but the stored prompt will still run."
            : "Repository cloning failed. The checkout is unavailable, but the stored prompt will still run.",
        diagnostics: commands.diagnostics(clone),
        recovery: "none",
      }),
    );
    return { checkoutState: "unavailable", issues };
  }
  const revision = await commands.run(["/usr/bin/git", "rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) {
    throw new ProvisioningFailure(
      sessionIssue({
        category: "report",
        severity: "failure",
        message: "Git could not report the cloned base commit.",
        diagnostics: commands.diagnostics(revision),
        recovery: "retry-provisioning",
      }),
    );
  }
  reporter.stage("creating-branch");
  const branch = await commands.run(["/usr/bin/git", "switch", "-C", definition.branchName]);
  if (branch.exitCode !== 0) {
    throw new ProvisioningFailure(
      sessionIssue({
        category: "clone",
        severity: "failure",
        message: "Git could not create the session branch.",
        diagnostics: commands.diagnostics(branch),
        recovery: "retry-provisioning",
      }),
    );
  }
  const baseCommit = revision.stdout.trim();
  reporter.checkedOut?.(baseCommit);
  reporter.stage("setup");
  const setup = await commands.run([
    "/bin/sh",
    "-lc",
    "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
  ]);
  await reportHook(reporter, "setup", setup);
  if (setup.exitCode !== 0) {
    issues.push(
      sessionIssue({
        category: "setup",
        severity: "warning",
        message:
          ".agents/setup failed, but the stored prompt will still run so Pi can diagnose or repair the project.",
        diagnostics: commands.diagnostics(setup),
        recovery: "none",
      }),
    );
  }
  return { checkoutState: "available", baseCommit, issues };
}

/** A hook that is absent, or ran silently and succeeded, leaves no transcript entry. */
function reportHook(
  reporter: ProvisioningReporter,
  step: "setup" | "resume",
  result: CommandOutput,
): Promise<void> {
  if (result.exitCode === 0 && result.output.trim() === "") return Promise.resolve();
  return reporter.output({ step, exitCode: result.exitCode, output: result.output });
}

/**
 * The transcript entry for a project command. The agent sees only a failure, which it may need to
 * repair; output of a command that succeeded is shown to viewers but costs the model nothing.
 */
export function setupEntry(outcome: SetupOutput, now: number) {
  const command = outcome.step === "clone" ? "Cloning the repository" : `.agents/${outcome.step}`;
  return {
    kind: SETUP_ENTRY_KIND,
    data: { step: outcome.step, exitCode: outcome.exitCode, output: outcome.output },
    ...(outcome.exitCode === 0
      ? {}
      : {
          model: [
            {
              role: "user" as const,
              content:
                `[OpenOrb] ${command} failed with exit status ${outcome.exitCode} while the ` +
                `environment was prepared. Its output${
                  outcome.output.trim() === "" ? " was empty." : `:\n\n${outcome.output}`
                }`,
              timestamp: now,
            },
          ],
        }),
  };
}

/**
 * Values redacted from setup output shown to Session viewers: the credentials the provider
 * received, which are the only real values the guest could echo.
 */
export function redactedValues(credentials: EnvironmentCredentials): readonly string[] {
  return [
    ...(credentials.githubToken === undefined ? [] : [credentials.githubToken]),
    ...(credentials.environmentSecrets ?? []).map((secret) => secret.value),
  ];
}

/** Creates /workspace: empty for a Session without a project, or to clone into. */
export async function createWorkspace(env: ExecutionEnv, context: Context): Promise<void> {
  const created = await env.createDir(WORKSPACE, { recursive: true }, context);
  if (!created.ok) {
    throw new ProvisioningFailure(
      sessionIssue({
        category: "environment-storage",
        severity: "failure",
        message: "The session workspace could not be created.",
        diagnostics: created.error.message,
        recovery: "retry-provisioning",
      }),
    );
  }
}

/** Runs `.agents/resume` after a restart of an available checkout. Failure is a warning. */
export async function resumeCheckout(
  env: ExecutionEnv,
  reporter: ProvisioningReporter,
  secrets: readonly string[],
  context: Context,
): Promise<readonly SessionIssue[]> {
  const commands = new GuestCommands(env, secrets, context);
  reporter.stage("resuming");
  const resume = await commands.run([
    "/bin/sh",
    "-lc",
    "if [ -x .agents/resume ]; then exec ./.agents/resume; fi",
  ]);
  await reportHook(reporter, "resume", resume);
  if (resume.exitCode === 0) return [];
  return [
    sessionIssue({
      category: "resume-hook",
      severity: "warning",
      message:
        ".agents/resume failed, but the prompt can still run so Pi can diagnose or repair the project.",
      diagnostics: commands.diagnostics(resume),
      recovery: "none",
    }),
  ];
}

export function sessionIssue(input: {
  readonly category: SessionIssueCategory;
  readonly severity: "warning" | "failure";
  readonly message: string;
  readonly diagnostics?: string | undefined;
  readonly recovery: SessionRecoveryAction;
}): SessionIssue {
  const diagnostics = input.diagnostics?.trim();
  return {
    category: input.category,
    severity: input.severity,
    message: input.message,
    ...(diagnostics ? { diagnostics } : {}),
    recovery: input.recovery,
  };
}

/** A newer issue replaces one of the same category; a new failure replaces older failures. */
export function appendIssues(
  current: readonly SessionIssue[],
  additions: readonly SessionIssue[],
): readonly SessionIssue[] {
  let next = [...current];
  for (const issue of additions) {
    next = next.filter(
      (existing) =>
        existing.category !== issue.category &&
        !(issue.severity === "failure" && existing.severity === "failure"),
    );
    next.push(issue);
  }
  return next.slice(-MAX_SESSION_ISSUES);
}

export function clearFailures(issues: readonly SessionIssue[]): readonly SessionIssue[] {
  return issues.filter((issue) => issue.severity !== "failure");
}

function gitFailureCategory(diagnostics: string): "github-authentication" | "clone" {
  return /authentication failed|bad credentials|could not read username|http (?:401|403)|access denied/iu.test(
    diagnostics,
  )
    ? "github-authentication"
    : "clone";
}

function sanitizeOutput(value: string): string {
  let sanitized = "";
  for (const codePoint of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) sanitized += codePoint;
  }
  return sanitized;
}

/** The end of `value` within the capture limit, marked when its start was dropped. */
function keepTail(value: string): string {
  if (encoder.encode(value).length <= MAX_CAPTURED_OUTPUT_BYTES) return value;
  const budget = MAX_CAPTURED_OUTPUT_BYTES - encoder.encode(OUTPUT_TRUNCATED_MESSAGE).length;
  const codePoints = Array.from(value);
  let start = codePoints.length;
  let bytes = 0;
  while (start > 0) {
    const size = encoder.encode(codePoints[start - 1]!).length;
    if (bytes + size > budget) break;
    bytes += size;
    start--;
  }
  return OUTPUT_TRUNCATED_MESSAGE + codePoints.slice(start).join("");
}
