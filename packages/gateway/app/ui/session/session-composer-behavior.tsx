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
      dialog.addEventListener("toggle", initializeSessionId, { signal: handle.signal });
      initializeSessionId();
    });
    return () => null;
  },
);
