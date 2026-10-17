import { css, type Handle } from "remix/component";

import { Button } from "../../../ui/public/components/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../ui/public/components/table.tsx";
import {
  configurationStatusStyle,
  formatSettingsDate,
  screenReaderOnlyStyle,
  sectionCopyStyle,
  sectionHeaderStyle,
  sectionHeadingStyle,
  settingsSectionStyle,
  tableFrameStyle,
} from "../settings-shared.ts";
import { DeleteProviderKeyDialog, ProviderKeyDialog } from "./provider-key-dialogs.tsx";
import type { SettingsSearchProvider } from "../settings-navigation.tsx";

/** One row per supported provider, in the order web_search tries them. */
export function SearchProviders(
  handle: Handle<{
    actionHref: string;
    csrfToken: string;
    providers: SettingsSearchProvider[];
  }>,
) {
  return () => (
    <section
      aria-labelledby="search-providers-heading"
      mix={[settingsSectionStyle, separatedSectionStyle]}
    >
      <header mix={sectionHeaderStyle}>
        <h2 id="search-providers-heading" mix={sectionHeadingStyle}>
          Web search
        </h2>
        <p mix={sectionCopyStyle}>
          The agent's web_search tool uses the first configured provider in this list and falls back
          to the next one when a search fails. Keys are encrypted and never shown after they are
          saved.
        </p>
      </header>
      <div mix={[tableFrameStyle, tableScrollStyle]}>
        <Table aria-label="Web search providers">
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead mix={actionsHeadStyle}>
                <span mix={screenReaderOnlyStyle}>Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {handle.props.providers.map((provider) => (
              <SearchProviderRow
                key={provider.providerId}
                actionHref={handle.props.actionHref}
                csrfToken={handle.props.csrfToken}
                provider={provider}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function SearchProviderRow(
  handle: Handle<{ actionHref: string; csrfToken: string; provider: SettingsSearchProvider }>,
) {
  const keyDialogId = `${handle.id}-key`;
  const deleteDialogId = `${handle.id}-delete`;
  return () => {
    const { actionHref, csrfToken, provider } = handle.props;
    return (
      <TableRow data-search-provider={provider.providerId}>
        <TableCell>
          <strong>{provider.name}</strong>
        </TableCell>
        <TableCell mix={configurationStatusStyle}>
          {provider.updatedAt === undefined ? (
            "Not configured"
          ) : (
            <>
              Configured · updated{" "}
              <time dateTime={provider.updatedAt}>{formatSettingsDate(provider.updatedAt)}</time>
            </>
          )}
        </TableCell>
        <TableCell mix={actionsCellStyle}>
          <div mix={actionsStyle}>
            <Button
              size="sm"
              variant={provider.updatedAt === undefined ? "default" : "outline"}
              commandFor={keyDialogId}
              command="show-modal"
            >
              {provider.updatedAt === undefined ? "Add key" : "Replace key"}
            </Button>
            {provider.updatedAt === undefined ? null : (
              <Button size="sm" variant="ghost" commandFor={deleteDialogId} command="show-modal">
                Delete
              </Button>
            )}
          </div>
          <ProviderKeyDialog
            actionHref={actionHref}
            csrfToken={csrfToken}
            dialogId={keyDialogId}
            intent="save-search-provider"
            providerId={provider.providerId}
            title={`${provider.name} API key`}
            description="The key is encrypted with the gateway master key and cannot be shown again."
            label="API key"
            submitLabel="Save key"
          />
          {provider.updatedAt === undefined ? null : (
            <DeleteProviderKeyDialog
              actionHref={actionHref}
              csrfToken={csrfToken}
              dialogId={deleteDialogId}
              intent="delete-search-provider"
              providerId={provider.providerId}
              title={`Delete ${provider.name} key?`}
              description={`web_search will stop using ${provider.name}. This cannot be undone.`}
              submitLabel="Delete key"
            />
          )}
        </TableCell>
      </TableRow>
    );
  };
}

// Follows the model providers section on the same page.
const separatedSectionStyle = css({ marginTop: "40px" });
// Narrow screens scroll the table inside its frame instead of widening the whole section.
const tableScrollStyle = css({ minWidth: 0, overflowX: "auto", overscrollBehaviorX: "contain" });
const actionsHeadStyle = css({ textAlign: "right" });
const actionsCellStyle = css({ position: "relative", textAlign: "right" });
const actionsStyle = css({ display: "inline-flex", gap: "8px" });
