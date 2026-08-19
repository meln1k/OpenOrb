import { clientEntry, css, type Handle, type Props } from "remix/ui";

import { media } from "@/app/ui/responsive.ts";

export function AlertDialog(handle: Handle<Props<"dialog">>) {
  return () => {
    const { children, id = handle.id, mix, role = "alertdialog", ...props } = handle.props;
    return (
      <dialog
        {...props}
        id={id}
        role={role}
        data-slot="alert-dialog-content"
        mix={[contentStyle, mix]}
      >
        {children}
        <DialogSubmitBehavior dialogId={id} open={Boolean(props.open)} />
      </dialog>
    );
  };
}

export const DialogSubmitBehavior = clientEntry<{ dialogId: string; open?: boolean }>(
  import.meta.url,
  function DialogSubmitBehavior(handle: Handle<{ dialogId: string; open?: boolean }>) {
    let wasOpenRequested = false;

    handle.queueTask(() => {
      const dialog = document.getElementById(handle.props.dialogId);
      if (!(dialog instanceof HTMLDialogElement)) return;
      const signal = handle.signal;

      dialog.addEventListener("submit", (event) => {
        setTimeout(() => {
          if (!signal.aborted && !event.defaultPrevented && dialog.open) dialog.close();
        }, 0);
      }, { signal });
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
