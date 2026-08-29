import { css, type Handle } from "remix/ui";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/ui/components/alert-dialog.tsx";
import { Button } from "@/app/ui/components/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/app/ui/components/card.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/app/ui/components/item.tsx";
import { Progress } from "@/app/ui/components/progress.tsx";
import { media } from "@/app/ui/responsive.ts";
import {
  listStyle,
  sectionCopyStyle,
  sectionHeaderStyle,
  sectionHeadingStyle,
  settingsSectionStyle,
} from "@/app/ui/settings/settings-shared.ts";
import type {
  SettingsEnrollmentCommand,
  SettingsRunner,
  SettingsRunnerCapacity,
} from "@/app/ui/settings/settings-navigation.tsx";

export function RunnersSection(
  handle: Handle<
    {
      actionHref: string;
      csrfToken: string;
      enrollmentCommand: SettingsEnrollmentCommand;
      runners: SettingsRunner[];
    }
  >,
) {
  const { actionHref, csrfToken, enrollmentCommand, runners } = handle.props;
  return () => (
    <section aria-labelledby="runners-heading" mix={settingsSectionStyle}>
      <header mix={sectionHeaderStyle}>
        <h2 id="runners-heading" mix={sectionHeadingStyle}>Runner enrollment</h2>
        <p mix={sectionCopyStyle}>Run from your OpenOrb checkout to enroll a runner.</p>
      </header>
      <section aria-label="Runner enrollment command">
        <EnrollmentCommand
          actionHref={actionHref}
          csrfToken={csrfToken}
          enrollmentCommand={enrollmentCommand.command}
        />
      </section>
      <section aria-label="Enrolled runners" mix={listStyle}>
        <header mix={runnerListHeaderStyle}>
          <h3 mix={tableTitleStyle}>Enrolled runners</h3>
        </header>
        {runners.length === 0
          ? <p mix={runnerEmptyStyle}>No runners enrolled.</p>
          : (
            <div mix={runnerCardsStyle}>
              {runners.map((runner) => (
                <RunnerCard
                  key={runner.id}
                  actionHref={actionHref}
                  csrfToken={csrfToken}
                  runner={runner}
                />
              ))}
            </div>
          )}
      </section>
    </section>
  );
}

function RunnerCard(
  handle: Handle<{ actionHref: string; csrfToken: string; runner: SettingsRunner }>,
) {
  const { actionHref, csrfToken, runner } = handle.props;
  const revokeDialogId = `${handle.id}-revoke`;
  const deleteDialogId = `${handle.id}-delete`;

  return () => {
    const allocation = runner.capacity ? placeholderRunnerAllocation(runner.capacity) : null;

    return (
      <Card mix={runnerCardStyle}>
        <CardHeader mix={runnerCardHeaderStyle}>
          <div mix={runnerIdentityStyle}>
            <h4 mix={runnerNameStyle}>{runner.name}</h4>
            <CardDescription mix={runnerSpecsStyle}>
              {formatRunnerSpecs(runner)}
            </CardDescription>
          </div>
          <CardAction mix={runnerCardActionStyle}>
            <span data-status={runner.status} mix={runnerStatusStyle}>
              <span
                aria-hidden="true"
                data-slot="status-bulb"
                data-status={runner.status}
                mix={runnerStatusBulbStyle}
              />
              {formatRunnerStatus(runner.status)}
            </span>
          </CardAction>
        </CardHeader>
        <CardContent mix={runnerCardContentStyle}>
          {runner.capacity && allocation
            ? (
              <div mix={runnerAllocationsStyle}>
                <RunnerAllocationBar
                  icon="cpu"
                  label="CPU allocated"
                  value={allocation.cpuCount}
                  max={runner.capacity.vmCpuCount}
                  valueLabel={`${allocation.cpuCount} of ${runner.capacity.vmCpuCount} CPUs`}
                />
                <RunnerAllocationBar
                  icon="memory"
                  label="Memory allocated"
                  value={allocation.memoryMiB}
                  max={runner.capacity.vmMemoryMiB}
                  valueLabel={`${formatMiB(allocation.memoryMiB)} of ${
                    formatMiB(runner.capacity.vmMemoryMiB)
                  }`}
                />
              </div>
            )
            : <p mix={runnerUnavailableStyle}>Allocation unavailable.</p>}
        </CardContent>
        <CardFooter mix={runnerCardFooterStyle}>
          <span mix={runnerSessionsStyle}>
            {runner.capacity ? formatRunnerSessions(runner.capacity) : "No live session data"}
          </span>
          {runner.status === "revoked"
            ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                commandFor={deleteDialogId}
                command="show-modal"
              >
                Delete
              </Button>
            )
            : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                commandFor={revokeDialogId}
                command="show-modal"
              >
                Revoke
              </Button>
            )}
        </CardFooter>
        {runner.status === "revoked"
          ? (
            <DeleteRunnerDialog
              actionHref={actionHref}
              csrfToken={csrfToken}
              dialogId={deleteDialogId}
              runner={runner}
            />
          )
          : (
            <RevokeRunnerDialog
              actionHref={actionHref}
              csrfToken={csrfToken}
              dialogId={revokeDialogId}
              runner={runner}
            />
          )}
      </Card>
    );
  };
}

function RunnerAllocationBar(
  handle: Handle<{
    icon: "cpu" | "memory";
    label: string;
    value: number;
    max: number;
    valueLabel: string;
  }>,
) {
  const { icon, label, max, value, valueLabel } = handle.props;

  return () => (
    <div mix={runnerAllocationStyle}>
      <div mix={runnerAllocationHeaderStyle}>
        <span mix={runnerAllocationLabelStyle}>
          <Icon name={icon} size={16} />
          {label}
        </span>
        <span mix={runnerAllocationValueStyle}>{valueLabel}</span>
      </div>
      <Progress
        aria-label={`${label}: ${valueLabel}`}
        value={value}
        max={max}
      />
    </div>
  );
}

function RevokeRunnerDialog(
  handle: Handle<{
    actionHref: string;
    csrfToken: string;
    dialogId: string;
    runner: SettingsRunner;
  }>,
) {
  const { actionHref, csrfToken, dialogId, runner } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog
      id={dialogId}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Revoke {runner.name}?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          The runner will disconnect immediately and must be enrolled again before it can reconnect.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="revoke-runner" />
        <input type="hidden" name="runnerId" value={runner.id} />
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Revoke runner</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function DeleteRunnerDialog(
  handle: Handle<{
    actionHref: string;
    csrfToken: string;
    dialogId: string;
    runner: SettingsRunner;
  }>,
) {
  const { actionHref, csrfToken, dialogId, runner } = handle.props;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;

  return () => (
    <AlertDialog
      id={dialogId}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <AlertDialogHeader>
        <AlertDialogTitle id={titleId}>Delete {runner.name}?</AlertDialogTitle>
        <AlertDialogDescription id={descriptionId}>
          This permanently removes the revoked runner record. This action cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <form method="post" action={actionHref} mix={dialogFormStyle}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="delete-runner" />
        <input type="hidden" name="runnerId" value={runner.id} />
        <AlertDialogFooter>
          <Button type="button" variant="outline" commandFor={dialogId} command="close">
            Cancel
          </Button>
          <Button type="submit" variant="destructive">Delete runner</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialog>
  );
}

function formatRunnerStatus(status: SettingsRunner["status"]): string {
  return status === "online" ? "Online" : status === "offline" ? "Offline" : "Revoked";
}

function formatRunnerSpecs(runner: SettingsRunner): string {
  if (!runner.capacity) return `${runner.architecture} · Capacity unavailable`;
  return `${runner.architecture} · ${runner.capacity.vmCpuCount} CPU · ${
    formatMiB(runner.capacity.vmMemoryMiB)
  } memory · ${formatMiB(runner.capacity.diskFreeMiB)} disk free`;
}

function formatRunnerSessions(capacity: SettingsRunnerCapacity): string {
  const activeSessions = `${capacity.activeSessions} active session${
    capacity.activeSessions === 1 ? "" : "s"
  }`;
  const sessionLimit = capacity.maxConcurrentSessions === undefined
    ? "No session limit"
    : `${capacity.maxConcurrentSessions} maximum`;
  return `${activeSessions} · ${sessionLimit}`;
}

function placeholderRunnerAllocation(capacity: SettingsRunnerCapacity) {
  // TODO: Replace these deterministic placeholders with allocations from the Gondolin VM inventory.
  return {
    cpuCount: Math.min(capacity.vmCpuCount, Math.max(1, Math.round(capacity.vmCpuCount * 0.35))),
    memoryMiB: Math.min(capacity.vmMemoryMiB, Math.round(capacity.vmMemoryMiB * 0.42)),
  };
}

function formatMiB(value: number): string {
  if (value < 1024) return `${value} MiB`;
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 1024)} GiB`;
}

function EnrollmentCommand(
  handle: Handle<{ actionHref: string; csrfToken: string; enrollmentCommand: string }>,
) {
  return () => (
    <Item
      variant="outline"
      size="sm"
      aria-label="Runner enrollment command"
      mix={enrollmentCommandItemStyle}
    >
      <ItemContent mix={enrollmentCommandContentStyle}>
        <ItemTitle mix={commandTitleStyle}>
          <code mix={commandValueStyle}>
            <span aria-hidden="true" mix={commandPromptStyle}>$</span>
            {handle.props.enrollmentCommand}
          </code>
        </ItemTitle>
      </ItemContent>
      <ItemActions mix={enrollmentCommandActionsStyle}>
        <form method="post" action={handle.props.actionHref}>
          <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
          <input type="hidden" name="intent" value="regenerate-enrollment-token" />
          <Button type="submit" size="sm" variant="outline">
            Regenerate
          </Button>
        </form>
      </ItemActions>
    </Item>
  );
}

const tableTitleStyle = css({ margin: 0, fontSize: "14px", fontWeight: 600 });
const runnerListHeaderStyle = css({ marginBottom: "12px" });
const runnerCardsStyle = css({
  display: "grid",
  gap: "16px",
  [media.md]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
});
const runnerCardStyle = css({ gap: "20px", paddingBlock: "20px", boxShadow: "none" });
const runnerCardHeaderStyle = css({ gap: "12px", paddingInline: "20px" });
const runnerCardActionStyle = css({ gridColumnStart: "2" });
const runnerIdentityStyle = css({
  display: "grid",
  gap: "5px",
  minWidth: 0,
});
const runnerNameStyle = css({ margin: 0, fontSize: "16px", fontWeight: 600, lineHeight: 1.25 });
const runnerSpecsStyle = css({ lineHeight: 1.45 });
const runnerStatusStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  minHeight: "24px",
  padding: "2px 8px",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  "&[data-status='revoked']": {
    color: "var(--destructive)",
    background: "color-mix(in oklab, var(--destructive) 10%, var(--background))",
  },
});
const runnerStatusBulbStyle = css({
  width: "7px",
  height: "7px",
  flexShrink: 0,
  background: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
  borderRadius: "999px",
  "&[data-status='online']": {
    background: "#22c55e",
    boxShadow: "0 0 0 2px color-mix(in oklab, #22c55e 18%, transparent)",
  },
  "&[data-status='revoked']": { background: "var(--destructive)" },
});
const runnerCardContentStyle = css({ paddingInline: "20px" });
const runnerAllocationsStyle = css({ display: "grid", gap: "18px" });
const runnerAllocationStyle = css({ display: "grid", gap: "8px" });
const runnerAllocationHeaderStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  fontSize: "13px",
});
const runnerAllocationLabelStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "7px",
  fontWeight: 500,
  "& svg": { color: "var(--muted-foreground)", flexShrink: 0 },
});
const runnerAllocationValueStyle = css({
  color: "var(--muted-foreground)",
  fontSize: "12px",
  textAlign: "right",
});
const runnerUnavailableStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "13px",
});
const runnerCardFooterStyle = css({
  justifyContent: "space-between",
  gap: "12px",
  paddingInline: "20px",
});
const runnerSessionsStyle = css({ color: "var(--muted-foreground)", fontSize: "12px" });
const runnerEmptyStyle = css({
  margin: 0,
  padding: "32px 16px",
  color: "var(--muted-foreground)",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius-lg)",
  textAlign: "center",
});
const enrollmentCommandItemStyle = css({ flexDirection: "column", alignItems: "stretch" });
const enrollmentCommandContentStyle = css({ flexBasis: "100%" });
const enrollmentCommandActionsStyle = css({
  justifyContent: "flex-end",
  width: "100%",
  flexWrap: "wrap",
});
const commandTitleStyle = css({
  display: "block",
  width: "100%",
  overflow: "visible",
  whiteSpace: "normal",
});
const commandValueStyle = css({
  display: "block",
  width: "100%",
  overflowWrap: "anywhere",
  userSelect: "all",
  whiteSpace: "pre-wrap",
});
const commandPromptStyle = css({
  marginRight: "0.5ch",
  color: "var(--muted-foreground)",
  userSelect: "none",
});

const dialogFormStyle = css({ display: "grid", gap: "20px" });
