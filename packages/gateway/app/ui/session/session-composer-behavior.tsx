import { clientEntry, type Handle } from "remix/ui";

export const SessionComposerBehavior = clientEntry<{ dialogId: string }>(
  import.meta.url,
  function SessionComposerBehavior(handle: Handle<{ dialogId: string }>) {
    handle.queueTask(() => {
      const dialog = document.getElementById(handle.props.dialogId);
      if (!(dialog instanceof HTMLDialogElement)) return;
      const submitPromptOnEnter = (event: KeyboardEvent) => {
        if (
          !(event.target instanceof HTMLTextAreaElement) ||
          event.target.name !== "initialPrompt" ||
          event.key !== "Enter" ||
          event.isComposing ||
          event.shiftKey
        ) return;
        event.preventDefault();
        const submitter = event.target.form?.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        );
        if (submitter && !submitter.disabled) event.target.form?.requestSubmit(submitter);
      };
      dialog.addEventListener("keydown", submitPromptOnEnter, { signal: handle.signal });
    });
    return () => null;
  },
);
