import { css, type Handle, type Props, type RemixNode } from "remix/ui";

export type FieldOrientation = "vertical" | "horizontal" | "responsive";
export type FieldProps = Props<"div"> & { orientation?: FieldOrientation };

export function FieldSet(handle: Handle<Props<"fieldset">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <fieldset {...props} data-slot="field-set" mix={[fieldSetStyle, mix]} />;
  };
}

export function FieldLegend(handle: Handle<Props<"legend"> & { variant?: "legend" | "label" }>) {
  return () => {
    const { mix, variant = "legend", ...props } = handle.props;
    return (
      <legend
        {...props}
        data-slot="field-legend"
        data-variant={variant}
        mix={[fieldLegendStyle, variant === "legend" ? legendStyle : legendLabelStyle, mix]}
      />
    );
  };
}

export function FieldGroup(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="field-group" mix={[fieldGroupStyle, mix]} />;
  };
}

export function Field(handle: Handle<FieldProps>) {
  return () => {
    const { mix, orientation = "vertical", ...props } = handle.props;
    return (
      <div
        {...props}
        role="group"
        data-slot="field"
        data-orientation={orientation}
        mix={[fieldBaseStyle, fieldOrientationStyles[orientation], mix]}
      />
    );
  };
}

export function FieldContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="field-content" mix={[fieldContentStyle, mix]} />;
  };
}

export function FieldLabel(handle: Handle<Props<"label">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <label {...props} data-slot="field-label" mix={[fieldLabelStyle, mix]} />;
  };
}

export function FieldTitle(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="field-label" mix={[fieldTitleStyle, mix]} />;
  };
}

export function FieldDescription(handle: Handle<Props<"p">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <p {...props} data-slot="field-description" mix={[fieldDescriptionStyle, mix]} />;
  };
}

export function FieldSeparator(
  handle: Handle<Props<"div"> & { children?: RemixNode }>,
) {
  return () => {
    const { children, mix, ...props } = handle.props;
    return (
      <div
        {...props}
        data-slot="field-separator"
        data-content={Boolean(children)}
        mix={[fieldSeparatorStyle, mix]}
      >
        <span aria-hidden="true" mix={separatorLineStyle} />
        {children
          ? (
            <span data-slot="field-separator-content" mix={separatorContentStyle}>
              {children}
            </span>
          )
          : null}
      </div>
    );
  };
}

export function FieldError(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, role = "alert", ...props } = handle.props;
    return <div {...props} role={role} data-slot="field-error" mix={[fieldErrorStyle, mix]} />;
  };
}

const fieldSetStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "24px",
  minWidth: 0,
  margin: 0,
  padding: 0,
  border: 0,
  "&:has(> [data-slot='checkbox-group']), &:has(> [data-slot='radio-group'])": {
    gap: "12px",
  },
});

const fieldLegendStyle = css({ marginBottom: "12px", padding: 0, fontWeight: 500 });
const legendStyle = css({ fontSize: "16px" });
const legendLabelStyle = css({ fontSize: "14px" });

const fieldGroupStyle = css({
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "28px",
  containerName: "field-group",
  containerType: "inline-size",
  "& > [data-slot='field-group']": { gap: "16px" },
});

const fieldBaseStyle = css({
  width: "100%",
  display: "flex",
  gap: "12px",
  "&[data-invalid='true']": { color: "var(--destructive)" },
});

const fieldOrientationStyles = {
  vertical: css({
    flexDirection: "column",
    "& > *": { width: "100%" },
  }),
  horizontal: css({
    flexDirection: "row",
    alignItems: "center",
    "& > [data-slot='field-label']": { flex: "1 1 auto" },
    "&:has(> [data-slot='field-content'])": { alignItems: "flex-start" },
    "&:has(> [data-slot='field-content']) > [data-slot='field-content'] > [role='checkbox'], &:has(> [data-slot='field-content']) > [data-slot='field-content'] > [role='radio']":
      {
        marginTop: "1px",
      },
  }),
  responsive: css({
    flexDirection: "column",
    "& > *": { width: "100%" },
    "@container field-group (min-width: 28rem)": {
      flexDirection: "row",
      alignItems: "center",
      "& > *": { width: "auto" },
      "& > [data-slot='field-label']": { flex: "1 1 auto" },
      "&:has(> [data-slot='field-content'])": { alignItems: "flex-start" },
      "&:has(> [data-slot='field-content']) > [data-slot='field-content'] > [role='checkbox'], &:has(> [data-slot='field-content']) > [data-slot='field-content'] > [role='radio']":
        {
          marginTop: "1px",
        },
    },
  }),
} as const;

const fieldContentStyle = css({
  display: "flex",
  flex: "1 1 0%",
  flexDirection: "column",
  gap: "6px",
  lineHeight: 1.375,
});

const fieldLabelStyle = css({
  width: "fit-content",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  color: "var(--foreground)",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1.375,
  userSelect: "none",
  "[data-slot='field'][data-disabled='true'] &": { opacity: 0.5 },
  "&:has(> [data-slot='field'])": {
    width: "100%",
    flexDirection: "column",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  "&:has(> [data-slot='field']) > [data-slot='field']": { padding: "16px" },
  "&:has([data-state='checked'])": {
    background: "color-mix(in oklab, var(--primary) 5%, transparent)",
    borderColor: "var(--primary)",
  },
  "@media (prefers-color-scheme: dark)": {
    "&:has([data-state='checked'])": {
      background: "color-mix(in oklab, var(--primary) 10%, transparent)",
    },
  },
});

const fieldTitleStyle = css({
  width: "fit-content",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1.375,
  "[data-slot='field'][data-disabled='true'] &": { opacity: 0.5 },
});

const fieldDescriptionStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
  fontWeight: 400,
  lineHeight: 1.5,
  "&:nth-last-child(2)": { marginTop: "-4px" },
  "[data-variant='legend'] + &": { marginTop: "-6px" },
  "[data-orientation='horizontal'] &": { textWrap: "balance" },
  "& > a": { color: "inherit", textDecoration: "underline", textUnderlineOffset: "4px" },
  "& > a:hover": { color: "var(--primary)" },
});

const fieldSeparatorStyle = css({
  position: "relative",
  height: "20px",
  marginBlock: "-8px",
  color: "var(--muted-foreground)",
  fontSize: "14px",
});

const separatorLineStyle = css({
  position: "absolute",
  inset: 0,
  top: "50%",
  height: "1px",
  background: "var(--border)",
});

const separatorContentStyle = css({
  position: "relative",
  width: "fit-content",
  display: "block",
  marginInline: "auto",
  paddingInline: "8px",
  background: "var(--background)",
});

const fieldErrorStyle = css({
  color: "var(--destructive)",
  fontSize: "14px",
  fontWeight: 400,
  "& ul": {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    margin: 0,
    marginLeft: "16px",
    padding: 0,
    listStyleType: "disc",
  },
});
