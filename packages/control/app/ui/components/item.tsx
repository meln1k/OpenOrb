import { css, type Handle, type Props } from "remix/ui";

export type ItemVariant = "default" | "outline" | "muted";
export type ItemSize = "default" | "sm" | "xs";
export type ItemMediaVariant = "default" | "icon" | "image";

export type ItemProps = Props<"div"> & {
  variant?: ItemVariant;
  size?: ItemSize;
};

export type ItemMediaProps = Props<"div"> & {
  variant?: ItemMediaVariant;
};

export function ItemGroup(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, role = "list", ...props } = handle.props;
    return <div {...props} role={role} data-slot="item-group" mix={[itemGroupStyle, mix]} />;
  };
}

export function ItemSeparator(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, role = "presentation", ...props } = handle.props;
    return (
      <div
        {...props}
        role={role}
        data-slot="item-separator"
        data-orientation="horizontal"
        mix={[itemSeparatorStyle, mix]}
      />
    );
  };
}

export function Item(handle: Handle<ItemProps>) {
  return () => {
    const { mix, size = "default", variant = "default", ...props } = handle.props;
    return (
      <div
        {...props}
        data-slot="item"
        data-variant={variant}
        data-size={size}
        mix={[itemBaseStyle, itemVariantStyles[variant], itemSizeStyles[size], mix]}
      />
    );
  };
}

export function ItemMedia(handle: Handle<ItemMediaProps>) {
  return () => {
    const { mix, variant = "default", ...props } = handle.props;
    return (
      <div
        {...props}
        data-slot="item-media"
        data-variant={variant}
        mix={[itemMediaBaseStyle, itemMediaVariantStyles[variant], mix]}
      />
    );
  };
}

export function ItemContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="item-content" mix={[itemContentStyle, mix]} />;
  };
}

export function ItemTitle(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="item-title" mix={[itemTitleStyle, mix]} />;
  };
}

export function ItemDescription(handle: Handle<Props<"p">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <p {...props} data-slot="item-description" mix={[itemDescriptionStyle, mix]} />;
  };
}

export function ItemActions(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="item-actions" mix={[itemActionsStyle, mix]} />;
  };
}

export function ItemHeader(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="item-header" mix={[itemHeaderStyle, mix]} />;
  };
}

export function ItemFooter(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="item-footer" mix={[itemFooterStyle, mix]} />;
  };
}

const itemGroupStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  "&:has([data-slot='item'][data-size='sm'])": { gap: "10px" },
  "&:has([data-slot='item'][data-size='xs'])": { gap: "8px" },
});

const itemSeparatorStyle = css({
  width: "100%",
  height: "1px",
  marginBlock: "8px",
  flexShrink: 0,
  background: "var(--border)",
});

const itemBaseStyle = css({
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  width: "100%",
  color: "var(--foreground)",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: "var(--radius-lg)",
  outline: "none",
  fontSize: "14px",
  transition: "color 100ms ease, background-color 100ms ease, border-color 100ms ease",
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)",
  },
});

const itemVariantStyles = {
  default: css({ borderColor: "transparent" }),
  outline: css({ borderColor: "var(--border)" }),
  muted: css({
    background: "color-mix(in oklab, var(--muted) 50%, transparent)",
    borderColor: "transparent",
  }),
} as const;

const itemSizeStyles = {
  default: css({ gap: "10px", padding: "10px 12px" }),
  sm: css({ gap: "10px", padding: "10px 12px" }),
  xs: css({ gap: "8px", padding: "8px 10px" }),
} as const;

const itemMediaBaseStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  flexShrink: 0,
  background: "transparent",
  "[data-slot='item']:has([data-slot='item-description']) &": {
    alignSelf: "flex-start",
    transform: "translateY(2px)",
  },
  "& svg": { pointerEvents: "none" },
});

const itemMediaVariantStyles = {
  default: css({}),
  icon: css({
    "& svg:not([class*='size-'])": { width: "16px", height: "16px" },
  }),
  image: css({
    width: "40px",
    height: "40px",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    "[data-slot='item'][data-size='sm'] &": { width: "32px", height: "32px" },
    "[data-slot='item'][data-size='xs'] &": { width: "24px", height: "24px" },
    "& img": { width: "100%", height: "100%", objectFit: "cover" },
  }),
} as const;

const itemContentStyle = css({
  display: "flex",
  flex: "1 1 0%",
  flexDirection: "column",
  gap: "4px",
  minWidth: 0,
  "[data-slot='item'][data-size='xs'] &": { gap: 0 },
  "& + [data-slot='item-content']": { flex: "none" },
});

const itemTitleStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "fit-content",
  maxWidth: "100%",
  overflow: "hidden",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1.375,
  textOverflow: "ellipsis",
  textUnderlineOffset: "4px",
  whiteSpace: "nowrap",
});

const itemDescriptionStyle = css({
  display: "-webkit-box",
  margin: 0,
  overflow: "hidden",
  color: "var(--muted-foreground)",
  fontSize: "14px",
  fontWeight: 400,
  lineHeight: 1.5,
  textAlign: "left",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  "[data-slot='item'][data-size='xs'] &": { fontSize: "12px" },
  "& > a": { color: "inherit", textDecoration: "underline", textUnderlineOffset: "4px" },
  "& > a:hover": { color: "var(--primary)" },
});

const itemActionsStyle = css({ display: "flex", alignItems: "center", gap: "8px" });

const itemHeaderStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  flexBasis: "100%",
});

const itemFooterStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  flexBasis: "100%",
});
