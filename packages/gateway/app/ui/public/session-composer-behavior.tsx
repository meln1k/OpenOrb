import { clientEntry, type Handle } from "remix/component";

export const SessionComposerBehavior = clientEntry<{ dialogId: string }>(
  import.meta.url,
  function SessionComposerBehavior(handle: Handle<{ dialogId: string }>) {
    handle.queueTask(() => {
      const dialog = document.getElementById(handle.props.dialogId);
      if (!(dialog instanceof HTMLDialogElement)) return;
      const handleComposerKeydown = (event: KeyboardEvent) => {
        if (
          event.key === "Tab" &&
          event.shiftKey &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.isComposing
        ) {
          const thinkingLevel = dialog.querySelector<HTMLButtonElement>(
            'button[aria-label="Thinking level"]',
          );
          if (!(thinkingLevel instanceof HTMLButtonElement)) return;
          event.preventDefault();
          thinkingLevel.dispatchEvent(new Event("openorb:cycle-thinking-level"));
          return;
        }
        if (!(event.target instanceof HTMLTextAreaElement) || event.target.name !== "initialPrompt")
          return;
        if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
        event.preventDefault();
        const submitter =
          event.target.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (submitter && !submitter.disabled) event.target.form?.requestSubmit(submitter);
      };
      // The dialog's styles follow these selections: the thinking-level border color, and the
      // Sandbox hides runner orb sizes.
      const reflectedSelections = new Map<string, "thinkingLevel" | "environment">([
        ["Thinking level", "thinkingLevel"],
        ["Environment", "environment"],
      ]);
      const reflectSelection = (event: Event) => {
        if (!(event.target instanceof HTMLButtonElement)) return;
        const name = reflectedSelections.get(event.target.getAttribute("aria-label") ?? "");
        if (name === undefined) return;
        const input = event.target.form?.elements.namedItem(name);
        if (!(input instanceof HTMLInputElement)) return;
        dialog.dataset[name] = input.value;
      };
      dialog.addEventListener("keydown", handleComposerKeydown, { signal: handle.signal });
      dialog.addEventListener("rmx:select-change", reflectSelection, { signal: handle.signal });
    });
    return () => null;
  },
);
