import { clientEntry, type Handle } from "remix/ui";

export const SessionComposerBehavior = clientEntry<{ dialogId: string }>(
  import.meta.url,
  function SessionComposerBehavior(handle: Handle<{ dialogId: string }>) {
    handle.queueTask(() => {
      const dialog = document.getElementById(handle.props.dialogId);
      if (!(dialog instanceof HTMLDialogElement)) return;
      const handleComposerKeydown = (event: KeyboardEvent) => {
        if (
          event.key === "Tab" && event.shiftKey && !event.altKey && !event.ctrlKey &&
          !event.metaKey && !event.isComposing
        ) {
          const thinkingLevel = dialog.querySelector<HTMLButtonElement>(
            'button[aria-label="Thinking level"]',
          );
          if (!(thinkingLevel instanceof HTMLButtonElement)) return;
          event.preventDefault();
          thinkingLevel.dispatchEvent(new Event("openorb:cycle-thinking-level"));
          return;
        }
        if (
          !(event.target instanceof HTMLTextAreaElement) ||
          event.target.name !== "initialPrompt"
        ) return;
        if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
        event.preventDefault();
        const submitter = event.target.form?.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        );
        if (submitter && !submitter.disabled) event.target.form?.requestSubmit(submitter);
      };
      const updateThinkingLevelColor = (event: Event) => {
        if (
          event.type !== "rmx:select-change" || !(event.target instanceof HTMLButtonElement) ||
          event.target.getAttribute("aria-label") !== "Thinking level"
        ) return;
        const thinkingLevel = event.target.form?.elements.namedItem("thinkingLevel");
        if (!(thinkingLevel instanceof HTMLInputElement)) return;
        dialog.dataset.thinkingLevel = thinkingLevel.value;
      };
      dialog.addEventListener("keydown", handleComposerKeydown, { signal: handle.signal });
      dialog.addEventListener("rmx:select-change", updateThinkingLevelColor, {
        signal: handle.signal,
      });
    });
    return () => null;
  },
);
