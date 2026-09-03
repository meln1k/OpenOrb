import { clientEntry, css, type Handle, type Props } from "remix/ui";

export type ResizableOrientation = "horizontal" | "vertical";
export type ResizableSize = string;

export type ResizablePanelGroupProps = Props<"div"> & {
  orientation?: ResizableOrientation;
};

export function ResizablePanelGroup(handle: Handle<ResizablePanelGroupProps>) {
  return () => {
    const {
      children,
      id = handle.id,
      mix,
      orientation = "horizontal",
      ...props
    } = handle.props;

    return (
      <div
        {...props}
        id={id}
        aria-orientation={orientation}
        data-orientation={orientation}
        data-slot="resizable-panel-group"
        mix={[panelGroupStyle, mix]}
      >
        {children}
        <ResizablePanelGroupBehavior groupId={id} orientation={orientation} />
      </div>
    );
  };
}

type ResizablePanelStyle = Exclude<Props<"div">["style"], string>;

export type ResizablePanelProps = Omit<Props<"div">, "style"> & {
  collapsible?: boolean;
  collapsedSize?: ResizableSize;
  defaultSize?: ResizableSize;
  maxSize?: ResizableSize;
  minSize?: ResizableSize;
  style?: ResizablePanelStyle;
};

export function ResizablePanel(handle: Handle<ResizablePanelProps>) {
  return () => {
    const {
      collapsible,
      collapsedSize,
      defaultSize,
      id = handle.id,
      maxSize,
      minSize,
      mix,
      style,
      ...props
    } = handle.props;

    return (
      <div
        {...props}
        id={id}
        data-collapsible={collapsible || undefined}
        data-collapsed-size={collapsedSize}
        data-default-size={defaultSize}
        data-max-size={maxSize}
        data-min-size={minSize}
        data-slot="resizable-panel"
        mix={[panelStyle, mix]}
        style={mergeInitialSize(style, defaultSize)}
      />
    );
  };
}

export type ResizableHandleProps = Props<"div"> & {
  disabled?: boolean;
  withHandle?: boolean;
};

export function ResizableHandle(handle: Handle<ResizableHandleProps>) {
  return () => {
    const {
      children,
      disabled = false,
      id = handle.id,
      mix,
      role = "separator",
      withHandle = false,
      ...props
    } = handle.props;

    return (
      <div
        {...props}
        id={id}
        role={role}
        aria-disabled={disabled || undefined}
        data-disabled={disabled || undefined}
        data-slot="resizable-handle"
        tabIndex={disabled ? -1 : 0}
        mix={[handleStyle, mix]}
      >
        {withHandle ? <div aria-hidden="true" data-slot="resizable-handle-icon" /> : null}
        {children}
      </div>
    );
  };
}

type ResizablePanelGroupBehaviorProps = {
  groupId: string;
  orientation: ResizableOrientation;
};

export const ResizablePanelGroupBehavior = clientEntry<ResizablePanelGroupBehaviorProps>(
  import.meta.url,
  function ResizablePanelGroupBehavior(handle: Handle<ResizablePanelGroupBehaviorProps>) {
    handle.queueTask(() => {
      const group = document.getElementById(handle.props.groupId);
      if (!(group instanceof HTMLDivElement)) return;

      const controller = new ResizableGroupController(group, handle.props.orientation);
      controller.connect(handle.signal);
    });

    return () => null;
  },
);

class ResizableGroupController {
  readonly #group: HTMLDivElement;
  readonly #orientation: ResizableOrientation;
  readonly #expandedSizes = new WeakMap<HTMLElement, number>();

  constructor(group: HTMLDivElement, orientation: ResizableOrientation) {
    this.#group = group;
    this.#orientation = orientation;
  }

  connect(signal: AbortSignal) {
    this.#updateAccessibility();
    this.#group.addEventListener("pointerdown", this.#onPointerDown, { signal });
    this.#group.addEventListener("keydown", this.#onKeyDown, { signal });

    const observer = new ResizeObserver(() => this.#updateAccessibility());
    observer.observe(this.#group);
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  }

  #onPointerDown = (event: PointerEvent) => {
    const separator = this.#separatorFromEvent(event);
    if (!separator || event.button !== 0) return;
    const pair = this.#getPanelPair(separator);
    if (!pair) return;

    event.preventDefault();
    separator.setPointerCapture(event.pointerId);
    separator.dataset.resizeActive = "true";

    const startCoordinate = this.#eventCoordinate(event);
    const startSizes = this.#panelSizes();
    const previousIndex = startSizes.panels.indexOf(pair.previous);
    const nextIndex = startSizes.panels.indexOf(pair.next);
    if (previousIndex < 0 || nextIndex < 0) return;

    const startPreviousSize = startSizes.sizes[previousIndex]!;
    const startNextSize = startSizes.sizes[nextIndex]!;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const direction = this.#resizeDirection();
      const delta = (this.#eventCoordinate(moveEvent) - startCoordinate) * direction;
      const constrainedDelta = this.#constrainDelta(
        delta,
        pair.previous,
        pair.next,
        startPreviousSize,
        startNextSize,
        startSizes.total,
      );
      const sizes = [...startSizes.sizes];
      sizes[previousIndex] = startPreviousSize + constrainedDelta;
      sizes[nextIndex] = startNextSize - constrainedDelta;
      this.#applyPanelSizes(startSizes.panels, sizes, [previousIndex, nextIndex]);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      separator.removeEventListener("pointermove", move);
      separator.removeEventListener("pointerup", finish);
      separator.removeEventListener("pointercancel", finish);
      separator.removeAttribute("data-resize-active");
      if (separator.hasPointerCapture(event.pointerId)) {
        separator.releasePointerCapture(event.pointerId);
      }
    };

    separator.addEventListener("pointermove", move);
    separator.addEventListener("pointerup", finish);
    separator.addEventListener("pointercancel", finish);
  };

  #onKeyDown = (event: KeyboardEvent) => {
    const separator = this.#separatorFromEvent(event);
    if (!separator) return;

    if (event.key === "F6") {
      event.preventDefault();
      this.#focusAdjacentSeparator(separator, event.shiftKey ? -1 : 1);
      return;
    }

    const pair = this.#getPanelPair(separator);
    if (!pair) return;
    const panelSizes = this.#panelSizes();
    const previousIndex = panelSizes.panels.indexOf(pair.previous);
    const nextIndex = panelSizes.panels.indexOf(pair.next);
    if (previousIndex < 0 || nextIndex < 0 || panelSizes.total <= 0) return;

    const previousSize = panelSizes.sizes[previousIndex]!;
    const nextSize = panelSizes.sizes[nextIndex]!;
    let delta: number | undefined;
    const step = panelSizes.total * 0.05;
    const direction = this.#resizeDirection();

    if (this.#orientation === "horizontal" && event.key === "ArrowLeft") delta = -step * direction;
    if (this.#orientation === "horizontal" && event.key === "ArrowRight") delta = step * direction;
    if (this.#orientation === "vertical" && event.key === "ArrowUp") delta = -step;
    if (this.#orientation === "vertical" && event.key === "ArrowDown") delta = step;
    if (event.key === "Home") delta = -panelSizes.total;
    if (event.key === "End") delta = panelSizes.total;
    if (event.key === "Enter" && pair.previous.dataset.collapsible === "true") {
      const collapsedSize = this.#sizeToPixels(
        pair.previous.dataset.collapsedSize,
        panelSizes.total,
      );
      if (previousSize > collapsedSize + 1) {
        this.#expandedSizes.set(pair.previous, previousSize);
        delta = collapsedSize - previousSize;
      } else {
        const defaultSize = this.#sizeToPixels(
          pair.previous.dataset.defaultSize,
          panelSizes.total,
        );
        delta = (this.#expandedSizes.get(pair.previous) ?? defaultSize) - previousSize;
      }
    }
    if (delta === undefined) return;

    event.preventDefault();
    const constrainedDelta = this.#constrainDelta(
      delta,
      pair.previous,
      pair.next,
      previousSize,
      nextSize,
      panelSizes.total,
    );
    const sizes = [...panelSizes.sizes];
    sizes[previousIndex] = previousSize + constrainedDelta;
    sizes[nextIndex] = nextSize - constrainedDelta;
    this.#applyPanelSizes(panelSizes.panels, sizes, [previousIndex, nextIndex]);
  };

  #separatorFromEvent(event: Event): HTMLElement | undefined {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const separator = target.closest<HTMLElement>("[data-slot='resizable-handle']");
    if (!separator || separator.parentElement !== this.#group) return;
    if (separator.dataset.disabled === "true") return;
    return separator;
  }

  #getPanelPair(separator: HTMLElement) {
    const previous = separator.previousElementSibling;
    const next = separator.nextElementSibling;
    if (!(previous instanceof HTMLElement) || previous.dataset.slot !== "resizable-panel") return;
    if (!(next instanceof HTMLElement) || next.dataset.slot !== "resizable-panel") return;
    return { previous, next };
  }

  #panels(): HTMLElement[] {
    return Array.from(this.#group.children).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element.dataset.slot === "resizable-panel"
    );
  }

  #separators(): HTMLElement[] {
    return Array.from(this.#group.children).filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element.dataset.slot === "resizable-handle"
    );
  }

  #panelSizes() {
    const panels = this.#panels();
    const sizes = panels.map((panel) => {
      const rect = panel.getBoundingClientRect();
      return this.#orientation === "horizontal" ? rect.width : rect.height;
    });
    return { panels, sizes, total: sizes.reduce((sum, size) => sum + size, 0) };
  }

  #applyPanelSizes(panels: HTMLElement[], sizes: number[], changedIndices: number[]) {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total <= 0) return;

    for (const index of changedIndices) {
      const panel = panels[index]!;
      const percentage = sizes[index]! / total * 100;
      panel.style.flexBasis = `${percentage}%`;
      panel.style.flexGrow = "0";
      panel.style.flexShrink = "1";
    }
    this.#updateAccessibility();
  }

  #constrainDelta(
    delta: number,
    previous: HTMLElement,
    next: HTMLElement,
    previousSize: number,
    nextSize: number,
    total: number,
  ) {
    const previousMin = this.#minimumSize(previous, total);
    const nextMin = this.#minimumSize(next, total);
    const previousMax = this.#maximumSize(previous, total);
    const nextMax = this.#maximumSize(next, total);
    const minimumDelta = Math.max(previousMin - previousSize, nextSize - nextMax);
    const maximumDelta = Math.min(previousMax - previousSize, nextSize - nextMin);
    return Math.min(Math.max(delta, minimumDelta), maximumDelta);
  }

  #minimumSize(panel: HTMLElement, total: number) {
    if (panel.dataset.collapsible === "true") {
      return this.#sizeToPixels(panel.dataset.collapsedSize, total);
    }
    return this.#sizeToPixels(panel.dataset.minSize, total);
  }

  #maximumSize(panel: HTMLElement, total: number) {
    const value = panel.dataset.maxSize;
    return value === undefined ? total : this.#sizeToPixels(value, total);
  }

  #sizeToPixels(value: string | undefined, total: number) {
    if (value === undefined || value === "") return 0;
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount)) return 0;
    if (value.endsWith("%")) return total * amount / 100;
    if (value.endsWith("rem")) {
      return amount * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    }
    if (value.endsWith("em")) {
      return amount * Number.parseFloat(getComputedStyle(this.#group).fontSize);
    }
    if (value.endsWith("vh")) return globalThis.innerHeight * amount / 100;
    if (value.endsWith("vw")) return globalThis.innerWidth * amount / 100;
    return amount;
  }

  #updateAccessibility() {
    const panelSizes = this.#panelSizes();
    if (panelSizes.total <= 0) return;

    for (const separator of this.#separators()) {
      const pair = this.#getPanelPair(separator);
      if (!pair) continue;
      const previousIndex = panelSizes.panels.indexOf(pair.previous);
      const nextIndex = panelSizes.panels.indexOf(pair.next);
      if (previousIndex < 0 || nextIndex < 0) continue;
      const previousSize = panelSizes.sizes[previousIndex]!;
      const nextSize = panelSizes.sizes[nextIndex]!;
      const minimum = Math.max(
        this.#minimumSize(pair.previous, panelSizes.total),
        previousSize + nextSize - this.#maximumSize(pair.next, panelSizes.total),
      );
      const maximum = Math.min(
        this.#maximumSize(pair.previous, panelSizes.total),
        previousSize + nextSize - this.#minimumSize(pair.next, panelSizes.total),
      );
      const percentage = (value: number) => String(Math.round(value / panelSizes.total * 100));

      separator.setAttribute(
        "aria-orientation",
        this.#orientation === "horizontal" ? "vertical" : "horizontal",
      );
      separator.setAttribute("aria-controls", pair.previous.id);
      separator.setAttribute("aria-valuemin", percentage(minimum));
      separator.setAttribute("aria-valuemax", percentage(maximum));
      separator.setAttribute("aria-valuenow", percentage(previousSize));
    }
  }

  #focusAdjacentSeparator(separator: HTMLElement, direction: number) {
    const separators = this.#separators().filter((item) => item.dataset.disabled !== "true");
    if (separators.length < 2) return;
    const currentIndex = separators.indexOf(separator);
    const nextIndex = (currentIndex + direction + separators.length) % separators.length;
    separators[nextIndex]?.focus();
  }

  #eventCoordinate(event: PointerEvent) {
    return this.#orientation === "horizontal" ? event.clientX : event.clientY;
  }

  #resizeDirection() {
    if (this.#orientation !== "horizontal") return 1;
    return getComputedStyle(this.#group).direction === "rtl" ? -1 : 1;
  }
}

function mergeInitialSize(style: ResizablePanelStyle, size: string | undefined) {
  if (!size) return style;
  return { ...style, flexBasis: size, flexGrow: 0 };
}

const panelGroupStyle = css({
  display: "flex",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  "&[data-orientation='vertical']": { flexDirection: "column" },
  "&[data-orientation='horizontal']": { flexDirection: "row" },
  "&[data-orientation='vertical'] > [data-slot='resizable-handle']": {
    width: "100%",
    height: 0,
    cursor: "row-resize",
  },
  "&[data-orientation='vertical'] > [data-slot='resizable-handle']::after": {
    inset: "50% 0 auto",
    width: "100%",
    height: "8px",
    transform: "translateY(-50%)",
  },
  "&[data-orientation='vertical'] > [data-slot='resizable-handle'] > [data-slot='resizable-handle-icon']":
    {
      transform: "rotate(90deg)",
    },
});

const panelStyle = css({
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  flex: "1 1 0",
});

const handleStyle = css({
  position: "relative",
  zIndex: 1,
  display: "flex",
  width: 0,
  height: "100%",
  flex: "0 0 auto",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--muted-foreground)",
  background: "transparent",
  border: 0,
  outline: "none",
  cursor: "col-resize",
  touchAction: "none",
  userSelect: "none",
  "&::after": {
    position: "absolute",
    inset: "0 auto 0 50%",
    width: "8px",
    content: '""',
    transform: "translateX(-50%)",
  },
  "&:focus-visible": {
    outline: "none",
  },
  "&:focus-visible > [data-slot='resizable-handle-icon'], &[data-resize-active='true'] > [data-slot='resizable-handle-icon']":
    {
      color: "var(--ring)",
      borderColor: "var(--ring)",
    },
  "&[data-disabled='true']": { cursor: "default", opacity: 0.5 },
  "& > [data-slot='resizable-handle-icon']": {
    position: "relative",
    zIndex: 1,
    width: "10px",
    height: "16px",
    flexShrink: 0,
    background: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "3px",
  },
  "& > [data-slot='resizable-handle-icon']::after": {
    position: "absolute",
    inset: "4px auto 4px 50%",
    width: "1px",
    content: '""',
    background: "currentColor",
    transform: "translateX(-50%)",
  },
});
