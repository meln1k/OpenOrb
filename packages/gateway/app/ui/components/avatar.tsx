import { css, type Handle, type Props } from "remix/ui";

export function Avatar(handle: Handle<Props<"span">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <span {...props} data-slot="avatar" mix={[avatarStyle, mix]} />;
  };
}

export function AvatarImage(handle: Handle<Props<"img">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <img {...props} data-slot="avatar-image" mix={[imageStyle, mix]} />;
  };
}

export function AvatarFallback(handle: Handle<Props<"span">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <span {...props} data-slot="avatar-fallback" mix={[fallbackStyle, mix]} />;
  };
}

const avatarStyle = css({
  position: "relative",
  display: "flex",
  flexShrink: 0,
  width: "32px",
  height: "32px",
  overflow: "hidden",
  borderRadius: "var(--radius-lg)",
  userSelect: "none",
});
const imageStyle = css({ width: "100%", height: "100%", objectFit: "cover" });
const fallbackStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: "100%",
  color: "var(--muted-foreground)",
  background: "var(--muted)",
  fontSize: "12px",
  fontWeight: 600,
});
