import { clientEntry, type Handle } from "remix/ui";

export const SessionComposerBehavior = clientEntry<{ dialogId: string }>(
  import.meta.url,
  function SessionComposerBehavior(handle: Handle<{ dialogId: string }>) {
    handle.queueTask(() => {
      const dialog = document.getElementById(handle.props.dialogId);
      if (!(dialog instanceof HTMLDialogElement)) return;
      const initializeSessionId = () => {
        if (!dialog.open) return;
        const input = dialog.querySelector<HTMLInputElement>('input[name="sessionId"]');
        if (input && input.value.length === 0) input.value = crypto.randomUUID();
      };
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
      dialog.addEventListener("toggle", initializeSessionId, { signal: handle.signal });
      dialog.addEventListener("keydown", submitPromptOnEnter, { signal: handle.signal });
      initializeSessionId();
    });
    return () => null;
  },
);
