import { css, type Handle, type Props } from "remix/ui";

export type MarkerVariant = "default" | "border" | "separator";

export type MarkerProps = Props<"div"> & {
  variant?: MarkerVariant;
};

export function Marker(handle: Handle<MarkerProps>) {
  return () => {
    const { mix, variant = "default", ...props } = handle.props;

    return (
      <div
        {...props}
        data-slot="marker"
        data-variant={variant}
        mix={[markerStyle, markerVariantStyles[variant], mix]}
      />
    );
  };
}

export function MarkerIcon(handle: Handle<Props<"span">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <span
        {...props}
        data-slot="marker-icon"
        aria-hidden="true"
        mix={[markerIconStyle, mix]}
      />
    );
  };
}

export function MarkerContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="marker-content" mix={[markerContentStyle, mix]} />;
  };
}

const markerStyle = css({
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minHeight: "16px",
  color: "var(--muted-foreground)",
  fontSize: "14px",
  textAlign: "left",
  "& > a, & [data-slot='marker-content'] > a": {
    color: "inherit",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
  "& > a:hover, & [data-slot='marker-content'] > a:hover": {
    color: "var(--foreground)",
  },
  "& svg": { width: "16px", height: "16px" },
});

const markerVariantStyles = {
  default: css({}),
  border: css({ paddingBottom: "8px", borderBottom: "1px solid var(--border)" }),
  separator: css({
    "&::before, &::after": {
      minWidth: 0,
      height: "1px",
      flex: 1,
      background: "var(--border)",
      content: "''",
    },
    "&::before": { marginRight: "4px" },
    "&::after": { marginLeft: "4px" },
    "& [data-slot='marker-content']": { flex: "none", textAlign: "center" },
  }),
} as const;

const markerIconStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: "16px",
  height: "16px",
  "& svg": { width: "16px", height: "16px" },
});

const markerContentStyle = css({
  minWidth: 0,
  overflowWrap: "anywhere",
});
