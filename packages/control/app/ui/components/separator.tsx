import { css, type Handle, type Props } from "remix/ui";

export type SeparatorProps = Props<"div"> & {
  decorative?: boolean;
  orientation?: "horizontal" | "vertical";
};

export function Separator(handle: Handle<SeparatorProps>) {
  return () => {
    const {
      decorative = true,
      mix,
      orientation = "horizontal",
      role,
      ...props
    } = handle.props;

    return (
      <div
        {...props}
        role={decorative ? "presentation" : role ?? "separator"}
        aria-orientation={decorative ? undefined : orientation}
        data-slot="separator"
        data-orientation={orientation}
        mix={[separatorStyle, mix]}
      />
    );
  };
}

const separatorStyle = css({
  flexShrink: 0,
  background: "var(--border)",
  "&[data-orientation='horizontal']": { width: "100%", height: "1px" },
  "&[data-orientation='vertical']": { width: "1px", height: "100%" },
});
