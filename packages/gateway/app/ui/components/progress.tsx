import { css, type Handle, type Props } from "remix/ui";

export type ProgressProps = Omit<Props<"div">, "children"> & {
  max?: number;
  value: number;
};

export function Progress(handle: Handle<ProgressProps>) {
  return () => {
    const { max = 100, mix, value, ...props } = handle.props;
    const safeMax = max > 0 ? max : 100;
    const safeValue = Math.min(Math.max(value, 0), safeMax);
    const percentage = safeValue / safeMax * 100;

    return (
      <div
        {...props}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={safeValue}
        data-slot="progress"
        mix={[progressStyle, mix]}
      >
        <div data-slot="progress-track" mix={progressTrackStyle}>
          <div
            data-slot="progress-indicator"
            mix={progressIndicatorStyle}
            style={{ transform: `translateX(-${100 - percentage}%)` }}
          />
        </div>
      </div>
    );
  };
}

const progressStyle = css({ width: "100%" });

const progressTrackStyle = css({
  width: "100%",
  height: "8px",
  overflow: "hidden",
  background: "var(--muted)",
  borderRadius: "999px",
});

const progressIndicatorStyle = css({
  width: "100%",
  height: "100%",
  background: "var(--primary)",
  borderRadius: "inherit",
  transition: "transform 200ms ease-out",
});
