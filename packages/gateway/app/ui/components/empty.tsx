import { css, type Handle, type Props } from "remix/ui";

export type EmptyMediaVariant = "default" | "icon";

export type EmptyMediaProps = Props<"div"> & {
  variant?: EmptyMediaVariant;
};

export function Empty(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="empty" mix={[emptyStyle, mix]} />;
  };
}

export function EmptyHeader(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="empty-header" mix={[emptyHeaderStyle, mix]} />;
  };
}

export function EmptyMedia(handle: Handle<EmptyMediaProps>) {
  return () => {
    const { mix, variant = "default", ...props } = handle.props;
    return (
      <div
        {...props}
        data-slot="empty-icon"
        data-variant={variant}
        mix={[emptyMediaBaseStyle, emptyMediaVariantStyles[variant], mix]}
      />
    );
  };
}

export function EmptyTitle(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="empty-title" mix={[emptyTitleStyle, mix]} />;
  };
}

export function EmptyDescription(handle: Handle<Props<"p">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <p {...props} data-slot="empty-description" mix={[emptyDescriptionStyle, mix]} />;
  };
}

export function EmptyContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="empty-content" mix={[emptyContentStyle, mix]} />;
  };
}

const emptyStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "1 1 0%",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  minWidth: 0,
  padding: "24px",
  borderStyle: "dashed",
  borderRadius: "var(--radius-xl)",
  textAlign: "center",
  textWrap: "balance",
});

const emptyHeaderStyle = css({
  display: "flex",
  alignItems: "center",
  flexDirection: "column",
  gap: "8px",
  width: "100%",
  maxWidth: "384px",
});

const emptyMediaBaseStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  marginBottom: "8px",
  "& svg": { flexShrink: 0, pointerEvents: "none" },
});

const emptyMediaVariantStyles = {
  default: css({ background: "transparent" }),
  icon: css({
    width: "32px",
    height: "32px",
    color: "var(--foreground)",
    background: "var(--muted)",
    borderRadius: "var(--radius-lg)",
    "& svg:not([class*='size-'])": { width: "16px", height: "16px" },
  }),
} as const;

const emptyTitleStyle = css({
  color: "var(--foreground)",
  fontSize: "14px",
  fontWeight: 500,
  letterSpacing: "-0.025em",
});

const emptyDescriptionStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
  lineHeight: 1.625,
  "& > a": { color: "inherit", textDecoration: "underline", textUnderlineOffset: "4px" },
  "& > a:hover": { color: "var(--primary)" },
});

const emptyContentStyle = css({
  display: "flex",
  alignItems: "center",
  flexDirection: "column",
  gap: "10px",
  width: "100%",
  maxWidth: "384px",
  minWidth: 0,
  fontSize: "14px",
  textWrap: "balance",
});
