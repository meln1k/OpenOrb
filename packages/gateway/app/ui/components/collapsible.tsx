import { css, type Handle, type Props } from "remix/ui";

export type CollapsibleProps = Props<"details"> & { defaultOpen?: boolean };

export function Collapsible(handle: Handle<CollapsibleProps>) {
  return () => {
    const { defaultOpen, mix, open, ...props } = handle.props;
    return (
      <details
        {...props}
        open={open ?? defaultOpen}
        data-slot="collapsible"
        mix={[collapsibleStyle, mix]}
      />
    );
  };
}

export function CollapsibleTrigger(handle: Handle<Props<"summary">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <summary {...props} data-slot="collapsible-trigger" mix={[triggerStyle, mix]} />;
  };
}

export function CollapsibleContent(handle: Handle<Props<"div">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <div {...props} data-slot="collapsible-content" mix={mix} />;
  };
}

const collapsibleStyle = css({ width: "100%" });
const triggerStyle = css({
  listStyle: "none",
  cursor: "pointer",
  "&::-webkit-details-marker": { display: "none" },
});
