import { css, type Handle, type Props } from "remix/ui";

export type TooltipProviderProps = Props<"div"> & {
  delay?: number;
};

export function TooltipProvider(handle: Handle<TooltipProviderProps>) {
  return () => {
    const { delay = 0, mix, ...props } = handle.props;
    return (
      <div
        {...props}
        data-slot="tooltip-provider"
        mix={[providerStyle, css({ "--tooltip-delay": `${delay}ms` }), mix]}
      />
    );
  };
}

interface TooltipScope {
  readonly anchorName: string;
  readonly contentId: string;
}

export function Tooltip(handle: Handle<Props<"span">, TooltipScope>) {
  const scope = {
    anchorName: `--tooltip-${handle.id}`,
    contentId: `${handle.id}-content`,
  };
  handle.context.set(scope);

  return () => {
    const { mix, ...props } = handle.props;
    return <span {...props} data-slot="tooltip" mix={[rootStyle, mix]} />;
  };
}

export function TooltipTrigger(handle: Handle<Props<"span">>) {
  const scope = handle.context.get(Tooltip);
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <span
        {...props}
        aria-describedby={scope.contentId}
        data-slot="tooltip-trigger"
        mix={[triggerStyle, css({ anchorName: scope.anchorName }), mix]}
      />
    );
  };
}

export type TooltipSide = "top" | "right" | "bottom" | "left";
export type TooltipAlign = "start" | "center" | "end";

export type TooltipContentProps = Omit<Props<"div">, "id"> & {
  align?: TooltipAlign;
  side?: TooltipSide;
  sideOffset?: number;
};

export function TooltipContent(handle: Handle<TooltipContentProps>) {
  const scope = handle.context.get(Tooltip);
  return () => {
    const {
      align = "center",
      children,
      mix,
      side = "top",
      sideOffset = 4,
      ...props
    } = handle.props;
    return (
      <div
        {...props}
        id={scope.contentId}
        role="tooltip"
        data-align={align}
        data-side={side}
        data-slot="tooltip-content"
        mix={[
          contentStyle,
          css({
            "--tooltip-side-offset": `${sideOffset}px`,
            positionAnchor: scope.anchorName,
          }),
          mix,
        ]}
      >
        {children}
        <span aria-hidden="true" data-slot="tooltip-arrow" mix={arrowStyle} />
      </div>
    );
  };
}

const providerStyle = css({ display: "contents" });

const rootStyle = css({
  position: "relative",
  display: "inline-flex",
  "& > [data-slot='tooltip-content']": {
    pointerEvents: "none",
    visibility: "hidden",
    opacity: 0,
    transition: "opacity 100ms ease, visibility 0s linear 100ms",
  },
  "&:hover > [data-slot='tooltip-content']": {
    pointerEvents: "auto",
    visibility: "visible",
    opacity: 1,
    transitionDelay: "var(--tooltip-delay, 0ms)",
  },
  "&:focus-within > [data-slot='tooltip-content']": {
    pointerEvents: "auto",
    visibility: "visible",
    opacity: 1,
    transitionDelay: "var(--tooltip-delay, 0ms)",
  },
});

const triggerStyle = css({ display: "inline-flex" });

const contentStyle = css({
  position: "fixed",
  zIndex: 50,
  width: "max-content",
  maxWidth: "320px",
  margin: 0,
  padding: "6px 10px",
  color: "var(--background)",
  background: "var(--foreground)",
  borderRadius: "var(--radius-md)",
  fontSize: "12px",
  fontWeight: 500,
  lineHeight: 1.35,
  "&[data-side='top']": {
    bottom: "calc(anchor(top) + var(--tooltip-side-offset))",
  },
  "&[data-side='bottom']": {
    top: "calc(anchor(bottom) + var(--tooltip-side-offset))",
  },
  "&[data-side='top'][data-align='start'], &[data-side='bottom'][data-align='start']": {
    left: "anchor(left)",
  },
  "&[data-side='top'][data-align='center'], &[data-side='bottom'][data-align='center']": {
    left: "anchor(center)",
    transform: "translateX(-50%)",
  },
  "&[data-side='top'][data-align='end'], &[data-side='bottom'][data-align='end']": {
    right: "anchor(right)",
  },
  "&[data-side='left']": {
    right: "calc(anchor(left) + var(--tooltip-side-offset))",
  },
  "&[data-side='right']": {
    left: "calc(anchor(right) + var(--tooltip-side-offset))",
  },
  "&[data-side='left'][data-align='start'], &[data-side='right'][data-align='start']": {
    top: "anchor(top)",
  },
  "&[data-side='left'][data-align='center'], &[data-side='right'][data-align='center']": {
    top: "anchor(center)",
    transform: "translateY(-50%)",
  },
  "&[data-side='left'][data-align='end'], &[data-side='right'][data-align='end']": {
    bottom: "anchor(bottom)",
  },
});

const arrowStyle = css({
  position: "absolute",
  width: "7px",
  height: "7px",
  background: "var(--foreground)",
  transform: "rotate(45deg)",
  "[data-side='top'] > &": { bottom: "-3px", left: "calc(50% - 3.5px)" },
  "[data-side='bottom'] > &": { top: "-3px", left: "calc(50% - 3.5px)" },
  "[data-side='left'] > &": { top: "calc(50% - 3.5px)", right: "-3px" },
  "[data-side='right'] > &": { top: "calc(50% - 3.5px)", left: "-3px" },
});
