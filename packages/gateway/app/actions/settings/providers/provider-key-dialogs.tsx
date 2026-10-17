import type { Handle, RemixNode } from "remix/component";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../ui/public/components/alert-dialog.tsx";
import { Button } from "../../../ui/public/components/button.tsx";
import { Field, FieldLabel } from "../../../ui/public/components/field.tsx";
import { Input } from "../../../ui/public/components/input.tsx";
import { dialogFormStyle } from "../settings-shared.ts";

interface ProviderKeyDialogProps {
  actionHref: string;
  csrfToken: string;
  dialogId: string;
  /** The form intent the providers controller dispatches on. */
  intent: string;
  providerId: string;
  title: RemixNode;
  description: RemixNode;
  submitLabel: string;
}

/** Saves an API key for one provider; shared by model and web search providers. */
export function ProviderKeyDialog(handle: Handle<ProviderKeyDialogProps & { label: string }>) {
  return () => {
    const { actionHref, csrfToken, dialogId, intent, providerId, label } = handle.props;
    return (
      <AlertDialog
        id={dialogId}
        role="dialog"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
      >
        <AlertDialogHeader>
          <AlertDialogTitle id={`${dialogId}-title`}>{handle.props.title}</AlertDialogTitle>
          <AlertDialogDescription id={`${dialogId}-description`}>
            {handle.props.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form method="post" action={actionHref} mix={dialogFormStyle}>
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="intent" value={intent} />
          <input type="hidden" name="providerId" value={providerId} />
          <Field>
            <FieldLabel for={`${dialogId}-value`}>{label}</FieldLabel>
            <Input
              id={`${dialogId}-value`}
              type="password"
              name="apiKey"
              autoComplete="off"
              required
            />
          </Field>
          <AlertDialogFooter>
            <Button type="button" variant="outline" commandFor={dialogId} command="close">
              Cancel
            </Button>
            <Button type="submit">{handle.props.submitLabel}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialog>
    );
  };
}

/** Confirms deleting one provider's stored key. */
export function DeleteProviderKeyDialog(handle: Handle<ProviderKeyDialogProps>) {
  return () => {
    const { actionHref, csrfToken, dialogId, intent, providerId } = handle.props;
    return (
      <AlertDialog
        id={dialogId}
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
      >
        <AlertDialogHeader>
          <AlertDialogTitle id={`${dialogId}-title`}>{handle.props.title}</AlertDialogTitle>
          <AlertDialogDescription id={`${dialogId}-description`}>
            {handle.props.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form method="post" action={actionHref}>
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="intent" value={intent} />
          <input type="hidden" name="providerId" value={providerId} />
          <AlertDialogFooter>
            <Button type="button" variant="outline" commandFor={dialogId} command="close">
              Cancel
            </Button>
            <Button type="submit" variant="destructive">
              {handle.props.submitLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialog>
    );
  };
}
