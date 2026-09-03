import { clientEntry, css, type Handle, type Props } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";

type DialogBehaviorProps = {
  dialogId: string;
  keepOpenWhileSubmitting?: boolean;
  open?: boolean;
};

interface AlertDialogProps extends Props<"dialog"> {
  keepOpenWhileSubmitting?: boolean;
}

export function AlertDialog(handle: Handle<AlertDialogProps>) {
  return () => {
    const {
      children,
      id = handle.id,
      keepOpenWhileSubmitting,
      mix,
      role = "alertdialog",
      ...props
    } = handle.props;
    return (
      <dialog
        {...props}
        id={id}
        role={role}
        data-slot="alert-dialog-content"
        mix={[contentStyle, mix]}
      >
        {children}
        <DialogBehavior
          dialogId={id}
          keepOpenWhileSubmitting={Boolean(keepOpenWhileSubmitting)}
          open={Boolean(props.open)}
        />
      </dialog>
    );
  };
}

export const DialogBehavior = clientEntry<DialogBehaviorProps>(
  import.meta.url,
  function DialogBehavior(handle: Handle<DialogBehaviorProps>) {
    let wasOpenRequested = false;
    let submittedAction: string | undefined;
    let submittedButton: HTMLButtonElement | undefined;
    const settleSubmission = () => {
      submittedAction = undefined;
      if (!submittedButton) return;
      submittedButton.disabled = submittedButton.dataset.submitEnabled !== "true";
      submittedButton.removeAttribute("aria-busy");
      const label = submittedButton.dataset.submitLabel;
      if (label) submittedButton.setAttribute("aria-label", label);
      submittedButton.querySelector("[data-slot='submit-idle']")?.removeAttribute("hidden");
      submittedButton.querySelector("[data-slot='spinner']")?.setAttribute("hidden", "");
      submittedButton = undefined;
    };

    handle.queueTask(() => {
      const dialog = document.getElementById(handle.props.dialogId);
      if (!(dialog instanceof HTMLDialogElement)) return;
      const signal = handle.signal;

      dialog.addEventListener("submit", (event) => {
        if (handle.props.keepOpenWhileSubmitting && event.target instanceof HTMLFormElement) {
          if (submittedAction !== undefined) {
            event.preventDefault();
            return;
          }
          submittedAction = event.target.action;
          const submitter = event instanceof SubmitEvent &&
              event.submitter instanceof HTMLButtonElement
            ? event.submitter
            : event.target.querySelector<HTMLButtonElement>("button[type='submit']");
          if (submitter) {
            submittedButton = submitter;
            submitter.disabled = true;
            submitter.setAttribute("aria-busy", "true");
            const pendingLabel = submitter.dataset.submitPendingLabel;
            if (pendingLabel) submitter.setAttribute("aria-label", pendingLabel);
            submitter.querySelector("[data-slot='submit-idle']")?.setAttribute("hidden", "");
            submitter.querySelector("[data-slot='spinner']")?.removeAttribute("hidden");
          }
          setTimeout(() => {
            if (!signal.aborted && event.defaultPrevented) settleSubmission();
          }, 0);
          return;
        }

        setTimeout(() => {
          if (!signal.aborted && !event.defaultPrevented && dialog.open) dialog.close();
        }, 0);
      }, { signal });

      globalThis.navigation.addEventListener("navigate", (event) => {
        if (event.downloadRequest !== null) return;
        if (submittedAction === event.destination.url) return;
        settleSubmission();
        if (dialog.open) dialog.close();
      }, { signal });
      globalThis.navigation.addEventListener("navigatesuccess", settleSubmission, { signal });
      globalThis.navigation.addEventListener("navigateerror", settleSubmission, { signal });
    });

    return () => {
      const openRequested = Boolean(handle.props.open);
      if (openRequested && !wasOpenRequested) {
        handle.queueTask((signal) => {
          if (signal.aborted) return;
          const dialog = document.getElementById(handle.props.dialogId);
          if (!(dialog instanceof HTMLDialogElement) || dialog.matches(":modal")) return;
          if (dialog.open) dialog.close();
          dialog.showModal();
        });
      }
      wasOpenRequested = openRequested;
      return null;
    };
  },
);

export function AlertDialogHeader(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="alert-dialog-header" mix={[headerStyle, mix]} />;
  };
}

export function AlertDialogTitle(handle: Handle<Props<"h2">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <h2 {...props} data-slot="alert-dialog-title" mix={[titleStyle, mix]} />;
  };
}

export function AlertDialogDescription(handle: Handle<Props<"p">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <p
        {...props}
        data-slot="alert-dialog-description"
        mix={[descriptionStyle, mix]}
      />
    );
  };
}

export function AlertDialogFooter(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="alert-dialog-footer" mix={[footerStyle, mix]} />;
  };
}

const contentStyle = css({
  position: "fixed",
  inset: "50% auto auto 50%",
  zIndex: 50,
  display: "none",
  gridTemplateColumns: "minmax(0, 1fr)",
  alignContent: "start",
  gap: "16px",
  width: "min(calc(100% - 32px), 512px)",
  minWidth: 0,
  height: "fit-content",
  maxHeight: "calc(100dvh - 32px)",
  margin: 0,
  padding: "24px",
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 16px 48px rgb(0 0 0 / 0.24)",
  outline: "none",
  overflowY: "auto",
  overflowWrap: "anywhere",
  textAlign: "left",
  whiteSpace: "normal",
  transform: "translate(-50%, -50%)",
  "&[open]": { display: "grid" },
  "&::backdrop": { background: "rgb(0 0 0 / 0.5)" },
});

const headerStyle = css({ display: "grid", gap: "8px", textAlign: "left" });
const titleStyle = css({
  margin: 0,
  fontSize: "18px",
  fontWeight: 600,
  letterSpacing: "-0.01em",
  lineHeight: 1.25,
});
const descriptionStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
  lineHeight: 1.5,
});
const footerStyle = css({
  display: "flex",
  flexDirection: "column-reverse",
  gap: "8px",
  justifyContent: "flex-end",
  [media.sm]: { flexDirection: "row" },
});
