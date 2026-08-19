import { css, type Handle, type Props } from "remix/ui";

export function Card(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="card" mix={[cardStyle, mix]} />;
  };
}

export function CardHeader(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="card-header" mix={[cardHeaderStyle, mix]} />;
  };
}

export function CardTitle(handle: Handle<Props<"h2">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <h2 {...props} data-slot="card-title" mix={[cardTitleStyle, mix]} />;
  };
}

export function CardDescription(handle: Handle<Props<"p">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <p {...props} data-slot="card-description" mix={[cardDescriptionStyle, mix]} />;
  };
}

export function CardAction(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="card-action" mix={[cardActionStyle, mix]} />;
  };
}

export function CardContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="card-content" mix={[cardContentStyle, mix]} />;
  };
}

export function CardFooter(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="card-footer" mix={[cardFooterStyle, mix]} />;
  };
}

export const cardTitleStyle = css({
  margin: 0,
  color: "var(--card-foreground)",
  fontSize: "inherit",
  fontWeight: 600,
  lineHeight: 1,
});

const cardStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "24px",
  paddingBlock: "24px",
  color: "var(--card-foreground)",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
});

const cardHeaderStyle = css({
  display: "grid",
  gridAutoRows: "min-content",
  gridTemplateRows: "auto auto",
  alignItems: "start",
  containerName: "card-header",
  containerType: "inline-size",
  gap: "8px",
  paddingInline: "24px",
  "&:has(> [data-slot='card-action'])": { gridTemplateColumns: "1fr auto" },
});

const cardDescriptionStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "14px",
});

const cardActionStyle = css({
  gridColumnStart: 2,
  gridRow: "1 / span 2",
  alignSelf: "start",
  justifySelf: "end",
});

const cardContentStyle = css({ paddingInline: "24px" });

const cardFooterStyle = css({
  display: "flex",
  alignItems: "center",
  paddingInline: "24px",
});
