import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  MAX_RPC_SESSION_EVENT_TEXT_BYTES,
  MAX_SESSION_ISSUES,
  type RunnerCheckoutState,
  type SessionIssue,
  type SessionIssueCategory,
  type SessionProvisioningStage,
  type SessionRecoveryAction,
} from "@openorb/protocol/runner-api";

// Project work runs in the guest over ExecutionEnv for every Agent Environment Provider
// (ADR 0006), with the commands, log budget, and issue model the runner used before.

const WORKSPACE = "/workspace";
const MAX_CAPTURED_COMMAND_BYTES = MAX_RPC_SESSION_EVENT_TEXT_BYTES / 2;
const MAX_PROVISIONING_LOG_BYTES = 256 * 1024;
const OUTPUT_TRUNCATED_MESSAGE = "\n[Provisioning output was truncated.]\n";

export interface CheckoutDefinition {
  readonly repositoryUrl: string;
  readonly ref: string;
  readonly branchName: string;
}

export interface ProvisioningReporter {
  readonly stage: (stage: SessionProvisioningStage) => void;
  readonly log: (stream: "stdout" | "stderr", text: string) => void;
}

export interface CheckoutResult {
  readonly checkoutState: RunnerCheckoutState;
  readonly baseCommit?: string;
  readonly issues: readonly SessionIssue[];
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ProvisioningFailure extends Error {
  readonly issue: SessionIssue;

  constructor(issue: SessionIssue) {
    super(issue.message);
    this.name = "ProvisioningFailure";
    this.issue = issue;
  }
}

/** Guest command output, bounded and redacted before it reaches any Session viewer. */
class GuestCommands {
  #remaining = MAX_PROVISIONING_LOG_BYTES;
  #truncated = false;

  constructor(
    private readonly env: ExecutionEnv,
    private readonly reporter: ProvisioningReporter,
    private readonly secrets: readonly string[],
    private readonly context: Context,
  ) {}

  async run(argv: readonly string[]): Promise<CommandOutput> {
    let stdout = "";
    let stderr = "";
    const result = await this.env.exec(argv, {
      cwd: WORKSPACE,
      onOutput: (text, _context, info) => {
        const clean = this.#redact(sanitizeOutput(text));
        if (info.stream === "stdout") stdout = appendBounded(stdout, clean);
        else stderr = appendBounded(stderr, clean);
        this.#emit(info.stream, clean);
      },
    }, this.context);
    if (!result.ok) {
      return { exitCode: -1, stdout, stderr: appendBounded(stderr, result.error.message) };
    }
    return { exitCode: result.value.exitCode, stdout, stderr };
  }

  note(stream: "stdout" | "stderr", text: string): void {
    this.#emit(stream, text);
  }

  diagnostics(output: CommandOutput): string | undefined {
    const text = [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
    return text ? takeUtf8(text, MAX_RPC_SESSION_EVENT_TEXT_BYTES).head : undefined;
  }

  #emit(stream: "stdout" | "stderr", text: string): void {
    while (text.length > 0 && this.#remaining > 0) {
      const { head, tail, bytes } = takeUtf8(
        text,
        Math.min(this.#remaining, MAX_RPC_SESSION_EVENT_TEXT_BYTES),
      );
      if (head.length === 0) break;
      this.reporter.log(stream, head);
      this.#remaining -= bytes;
      text = tail;
    }
    if (text.length > 0 && !this.#truncated) {
      this.#truncated = true;
      this.reporter.log("stderr", OUTPUT_TRUNCATED_MESSAGE);
    }
  }

  #redact(text: string): string {
    let redacted = text;
    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
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
  const commands = new GuestCommands(env, reporter, secrets, context);
  const issues: SessionIssue[] = [];
  const created = await env.createDir(WORKSPACE, { recursive: true }, context);
  if (!created.ok) {
    throw new ProvisioningFailure(sessionIssue({
      category: "runner-storage",
      severity: "failure",
      message: "The session workspace could not be prepared for cloning.",
      diagnostics: created.error.message,
      recovery: "retry-provisioning",
    }));
  }
  const cleared = await commands.run(["/usr/bin/find", WORKSPACE, "-mindepth", "1", "-delete"]);
  if (cleared.exitCode !== 0) {
    throw new ProvisioningFailure(sessionIssue({
      category: "runner-storage",
      severity: "failure",
      message: "The session workspace could not be prepared for cloning.",
      diagnostics: commands.diagnostics(cleared),
      recovery: "retry-provisioning",
    }));
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
    const category = gitFailureCategory(`${clone.stdout}\n${clone.stderr}`);
    issues.push(sessionIssue({
      category,
      severity: "warning",
      message: category === "github-authentication"
        ? "GitHub authentication failed while cloning. The checkout is unavailable, but the stored prompt will still run."
        : "Repository cloning failed. The checkout is unavailable, but the stored prompt will still run.",
      diagnostics: commands.diagnostics(clone),
      recovery: "none",
    }));
    commands.note(
      "stderr",
      "Repository clone failed. The checkout is unavailable; the stored prompt remains ready for Pi.\n",
    );
    return { checkoutState: "unavailable", issues };
  }
  const revision = await commands.run(["/usr/bin/git", "rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) {
    throw new ProvisioningFailure(sessionIssue({
      category: "report",
      severity: "failure",
      message: "Git could not report the cloned base commit.",
      diagnostics: commands.diagnostics(revision),
      recovery: "retry-provisioning",
    }));
  }
  reporter.stage("creating-branch");
  const branch = await commands.run(["/usr/bin/git", "switch", "-C", definition.branchName]);
  if (branch.exitCode !== 0) {
    throw new ProvisioningFailure(sessionIssue({
      category: "clone",
      severity: "failure",
      message: "Git could not create the session branch.",
      diagnostics: commands.diagnostics(branch),
      recovery: "retry-provisioning",
    }));
  }
  reporter.stage("setup");
  const setup = await commands.run([
    "/bin/sh",
    "-lc",
    "if [ -x .agents/setup ]; then exec ./.agents/setup; fi",
  ]);
  if (setup.exitCode !== 0) {
    issues.push(sessionIssue({
      category: "setup",
      severity: "warning",
      message:
        ".agents/setup failed, but the stored prompt will still run so Pi can diagnose or repair the project.",
      diagnostics: commands.diagnostics(setup),
      recovery: "none",
    }));
    commands.note(
      "stderr",
      `.agents/setup exited with status ${setup.exitCode}; continuing to Pi so it can repair the project.\n`,
    );
  }
  return { checkoutState: "available", baseCommit: revision.stdout.trim(), issues };
}

/** Runs `.agents/resume` after a restart of an available checkout. Failure is a warning. */
export async function resumeCheckout(
  env: ExecutionEnv,
  reporter: ProvisioningReporter,
  secrets: readonly string[],
  context: Context,
): Promise<readonly SessionIssue[]> {
  const commands = new GuestCommands(env, reporter, secrets, context);
  reporter.stage("resuming");
  const resume = await commands.run([
    "/bin/sh",
    "-lc",
    "if [ -x .agents/resume ]; then exec ./.agents/resume; fi",
  ]);
  if (resume.exitCode === 0) return [];
  commands.note(
    "stderr",
    `.agents/resume exited with status ${resume.exitCode}; continuing to Pi so it can repair the project.\n`,
  );
  return [sessionIssue({
    category: "resume-hook",
    severity: "warning",
    message:
      ".agents/resume failed, but the prompt can still run so Pi can diagnose or repair the project.",
    diagnostics: commands.diagnostics(resume),
    recovery: "none",
  })];
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
    next = next.filter((existing) =>
      existing.category !== issue.category &&
      !(issue.severity === "failure" && existing.severity === "failure")
    );
    next.push(issue);
  }
  return next.slice(-MAX_SESSION_ISSUES);
}

export function clearFailures(issues: readonly SessionIssue[]): readonly SessionIssue[] {
  return issues.filter((issue) => issue.severity !== "failure");
}

function gitFailureCategory(diagnostics: string): "github-authentication" | "clone" {
  return /authentication failed|bad credentials|could not read username|http (?:401|403)|access denied/iu
      .test(diagnostics)
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

function appendBounded(current: string, next: string): string {
  const remaining = MAX_CAPTURED_COMMAND_BYTES - new TextEncoder().encode(current).length;
  return remaining <= 0 ? current : current + takeUtf8(next, remaining).head;
}

function takeUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0 || value.length === 0) return { head: "", tail: value, bytes: 0 };
  const encoder = new TextEncoder();
  let end = 0;
  let bytes = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return { head: value.slice(0, end), tail: value.slice(end), bytes };
}
