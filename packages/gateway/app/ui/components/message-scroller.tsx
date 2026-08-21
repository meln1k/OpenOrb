import { css, type Handle, on, type Props, ref } from "remix/ui";

import { Button, type ButtonProps } from "@/app/ui/components/button.tsx";
import { Icon } from "@/app/ui/components/icons.tsx";

type ScrollPosition = "start" | "end" | "last-anchor";
type ScrollMode = "following-bottom" | "free-scrolling" | "anchored-to-message";

export type MessageScrollerProps = Props<"div"> & {
  autoScroll?: boolean;
  defaultScrollPosition?: ScrollPosition;
  scrollPreviousItemPeek?: number;
};

export type MessageScrollerItemProps = Props<"div"> & {
  messageId?: string;
  scrollAnchor?: boolean;
};

export type MessageScrollerButtonProps = Omit<ButtonProps, "children" | "size">;

const EDGE_THRESHOLD = 8;
const POSITION_EPSILON = 0.5;
const AUTOSCROLL_DURATION_MS = 180;
const CONTENT_GAP_PX = 32;
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
]);

class MessageScrollerController {
  autoScroll = true;
  defaultScrollPosition: ScrollPosition = "end";
  previousItemPeek = 64;

  #root: HTMLElement | null = null;
  #viewport: HTMLElement | null = null;
  #content: HTMLElement | null = null;
  #button: HTMLButtonElement | null = null;
  #mode: ScrollMode = "following-bottom";
  #initialized = false;
  #seenItems = new Set<string>();
  #anchoredMessageId: string | null = null;
  #previousScrollTop = 0;
  #autoscrolling = false;
  #autoscrollTimer: ReturnType<typeof setTimeout> | undefined;
  #initialPositionTimer: ReturnType<typeof setTimeout> | undefined;
  #resizeObserver: ResizeObserver | null = null;
  #resizeFrame: number | undefined;

  configure(
    autoScroll: boolean,
    defaultScrollPosition: ScrollPosition,
    previousItemPeek: number,
  ) {
    this.autoScroll = autoScroll;
    this.defaultScrollPosition = defaultScrollPosition;
    this.previousItemPeek = previousItemPeek;
  }

  attachRoot(node: HTMLElement, signal: AbortSignal) {
    this.#root = node;
    signal.addEventListener("abort", () => {
      if (this.#root === node) this.#root = null;
    }, { once: true });
  }

  attachViewport(node: HTMLElement, signal: AbortSignal) {
    this.#viewport = node;
    this.#previousScrollTop = node.scrollTop;
    this.#connectResizeObserver();
    signal.addEventListener("abort", () => {
      if (this.#viewport !== node) return;
      this.#viewport = null;
      this.#disconnectResizeObserver();
    }, { once: true });
  }

  attachContent(node: HTMLElement, signal: AbortSignal) {
    this.#content = node;
    this.#connectResizeObserver();
    signal.addEventListener("abort", () => {
      if (this.#content !== node) return;
      this.#content = null;
      this.#disconnectResizeObserver();
    }, { once: true });
  }

  attachButton(node: HTMLButtonElement, signal: AbortSignal) {
    this.#button = node;
    this.#updateScrollState();
    signal.addEventListener("abort", () => {
      if (this.#button === node) this.#button = null;
    }, { once: true });
  }

  reconcile() {
    const items = this.#items();
    if (items.length === 0) {
      this.#resetEmptyTranscript();
      return;
    }

    if (!this.#initialized) {
      this.#scheduleInitialPosition();
      this.#updateScrollState();
      return;
    }

    const addedItems = items.filter((item) => {
      const id = item.dataset.messageId;
      return id !== undefined && !this.#seenItems.has(id);
    });
    for (const item of items) {
      const id = item.dataset.messageId;
      if (id !== undefined) this.#seenItems.add(id);
    }

    const addedAnchors = addedItems.filter((item) => item.dataset.scrollAnchor === "true");
    if (addedAnchors.length > 0) {
      const anchor = addedAnchors[0];
      if (
        this.autoScroll &&
        this.#mode === "following-bottom" &&
        addedAnchors.length > 1
      ) {
        this.scrollToEnd("auto");
      } else if (anchor) {
        this.#anchorTo(anchor);
      }
      return;
    }

    if (this.#mode === "anchored-to-message") {
      this.#maintainAnchor();
    } else if (this.autoScroll && this.#mode === "following-bottom") {
      this.scrollToEnd("auto");
    } else {
      this.#updateScrollState();
    }
  }

  onScroll() {
    const viewport = this.#viewport;
    if (!viewport) return;

    const movedUp = viewport.scrollTop < this.#previousScrollTop - POSITION_EPSILON;
    this.#previousScrollTop = viewport.scrollTop;
    if (!this.#autoscrolling && movedUp) this.#releaseFollow();
    if (!this.#autoscrolling && this.#isAtEnd() && this.autoScroll) {
      this.#mode = "following-bottom";
      this.#anchoredMessageId = null;
    }
    this.#updateScrollState();
  }

  onUserIntent() {
    this.#releaseFollow();
    this.#updateScrollState();
  }

  onKeyDown(key: string) {
    if (SCROLL_KEYS.has(key)) this.onUserIntent();
  }

  scrollToEnd(behavior: ScrollBehavior = "smooth") {
    const viewport = this.#viewport;
    if (!viewport) return;

    this.#setSpacerHeight(0);
    this.#anchoredMessageId = null;
    this.#mode = this.autoScroll ? "following-bottom" : "free-scrolling";
    this.#markAutoscrolling();
    viewport.scrollTo({ top: viewport.scrollHeight - viewport.clientHeight, behavior });
    this.#previousScrollTop = viewport.scrollTop;
    this.#updateScrollState();
  }

  #scheduleInitialPosition() {
    // Continuous replay or streaming must not postpone the first positioning pass.
    if (this.#initialPositionTimer !== undefined) return;
    this.#initialPositionTimer = setTimeout(() => {
      this.#initialPositionTimer = undefined;
      this.#positionInitialTranscript();
    }, 60);
  }

  #positionInitialTranscript() {
    const viewport = this.#viewport;
    const items = this.#items();
    if (!viewport || items.length === 0) return;

    this.#initialized = true;
    this.#seenItems = new Set(
      items.flatMap((item) => item.dataset.messageId ? [item.dataset.messageId] : []),
    );

    if (this.defaultScrollPosition === "start") {
      this.#mode = "free-scrolling";
      this.#setSpacerHeight(0);
      viewport.scrollTop = 0;
      this.#previousScrollTop = 0;
      this.#updateScrollState();
      return;
    }

    if (this.defaultScrollPosition === "last-anchor") {
      const anchor = items.findLast((item) => item.dataset.scrollAnchor === "true");
      if (anchor && !this.#anchorSuffixFits(anchor)) {
        this.#anchorTo(anchor);
        return;
      }
    }

    this.scrollToEnd("auto");
  }

  #anchorTo(anchor: HTMLElement) {
    const viewport = this.#viewport;
    if (!viewport) return;
    const messageId = anchor.dataset.messageId;
    if (!messageId) return;

    this.#mode = "anchored-to-message";
    this.#anchoredMessageId = messageId;
    const desiredScrollTop = this.#anchorScrollTop(anchor);
    this.#resizeSpacerFor(desiredScrollTop);
    this.#markAutoscrolling();
    viewport.scrollTop = desiredScrollTop;
    this.#previousScrollTop = viewport.scrollTop;
    this.#updateScrollState();
  }

  #maintainAnchor() {
    const anchor = this.#items().find((item) => item.dataset.messageId === this.#anchoredMessageId);
    if (!anchor) {
      this.#mode = "free-scrolling";
      this.#anchoredMessageId = null;
      this.#setSpacerHeight(0);
      this.#updateScrollState();
      return;
    }

    const desiredScrollTop = this.#anchorScrollTop(anchor);
    const previousSpacerHeight = this.#spacerHeight();
    const nextSpacerHeight = this.#resizeSpacerFor(desiredScrollTop);
    if (
      previousSpacerHeight > POSITION_EPSILON &&
      nextSpacerHeight <= POSITION_EPSILON
    ) {
      this.scrollToEnd("auto");
      return;
    }

    const viewport = this.#viewport;
    if (!viewport) return;
    this.#markAutoscrolling();
    viewport.scrollTop = desiredScrollTop;
    this.#previousScrollTop = viewport.scrollTop;
    this.#updateScrollState();
  }

  #releaseFollow() {
    if (this.#autoscrolling) this.#clearAutoscrolling();
    this.#mode = "free-scrolling";
    this.#anchoredMessageId = null;
    // Retain the tail spacer so releasing an anchored turn cannot shift the viewport.
  }

  #anchorSuffixFits(anchor: HTMLElement): boolean {
    const viewport = this.#viewport;
    if (!viewport) return true;
    return this.#realContentBottom() - this.#itemTop(anchor) <= viewport.clientHeight;
  }

  #anchorScrollTop(anchor: HTMLElement): number {
    return Math.max(0, this.#itemTop(anchor) - this.previousItemPeek);
  }

  #itemTop(item: HTMLElement): number {
    const viewport = this.#viewport;
    if (!viewport) return 0;
    return viewport.scrollTop + item.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top;
  }

  #realContentBottom(): number {
    const viewport = this.#viewport;
    const content = this.#content;
    const lastItem = this.#items().at(-1);
    if (!viewport || !content || !lastItem) return 0;
    const paddingBottom = Number.parseFloat(getComputedStyle(content).paddingBottom) || 0;
    return viewport.scrollTop + lastItem.getBoundingClientRect().bottom -
      viewport.getBoundingClientRect().top + paddingBottom;
  }

  #resizeSpacerFor(desiredScrollTop: number): number {
    const viewport = this.#viewport;
    if (!viewport) return 0;
    const height = Math.max(
      0,
      Math.ceil(desiredScrollTop + viewport.clientHeight - this.#realContentBottom()),
    );
    this.#setSpacerHeight(height);
    return height;
  }

  #spacerHeight(): number {
    const spacer = this.#content?.querySelector<HTMLElement>("[data-message-scroller-spacer]");
    return Number.parseFloat(spacer?.style.height ?? "") || 0;
  }

  #setSpacerHeight(height: number) {
    const spacer = this.#content?.querySelector<HTMLElement>("[data-message-scroller-spacer]");
    if (spacer) spacer.style.height = `${height}px`;
  }

  #items(): HTMLElement[] {
    if (!this.#content) return [];
    return Array.from(
      this.#content.querySelectorAll<HTMLElement>(
        ":scope > [data-slot='message-scroller-item'][data-message-id]",
      ),
    );
  }

  #isAtEnd(): boolean {
    const viewport = this.#viewport;
    if (!viewport) return true;
    // Spacer-only overflow preserves an anchor; it is not unread transcript content.
    return this.#realContentBottom() - viewport.scrollTop - viewport.clientHeight <= EDGE_THRESHOLD;
  }

  #updateScrollState() {
    const viewport = this.#viewport;
    if (!viewport) return;
    const start = viewport.scrollTop > EDGE_THRESHOLD;
    const end = this.#mode !== "following-bottom" && !this.#isAtEnd();
    const scrollable = [start ? "start" : "", end ? "end" : ""].filter(Boolean).join(" ");

    for (const node of [this.#root, viewport]) {
      if (!node) continue;
      if (scrollable) node.dataset.scrollable = scrollable;
      else delete node.dataset.scrollable;
    }
    if (!this.#button) return;
    this.#button.dataset.active = String(end);
    this.#button.inert = !end;
    this.#button.tabIndex = end ? 0 : -1;
  }

  #markAutoscrolling() {
    this.#autoscrolling = true;
    this.#root?.setAttribute("data-autoscrolling", "");
    this.#viewport?.setAttribute("data-autoscrolling", "");
    if (this.#autoscrollTimer !== undefined) clearTimeout(this.#autoscrollTimer);
    this.#autoscrollTimer = setTimeout(() => this.#clearAutoscrolling(), AUTOSCROLL_DURATION_MS);
  }

  #clearAutoscrolling() {
    this.#autoscrolling = false;
    this.#root?.removeAttribute("data-autoscrolling");
    this.#viewport?.removeAttribute("data-autoscrolling");
    if (this.#autoscrollTimer !== undefined) clearTimeout(this.#autoscrollTimer);
    this.#autoscrollTimer = undefined;
  }

  #resetEmptyTranscript() {
    this.#initialized = false;
    this.#seenItems.clear();
    this.#anchoredMessageId = null;
    this.#mode = this.autoScroll ? "following-bottom" : "free-scrolling";
    this.#setSpacerHeight(0);
    this.#updateScrollState();
  }

  #connectResizeObserver() {
    if (!this.#viewport || !this.#content || this.#resizeObserver) return;
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#resizeFrame !== undefined) cancelAnimationFrame(this.#resizeFrame);
      this.#resizeFrame = requestAnimationFrame(() => {
        this.#resizeFrame = undefined;
        if (this.#mode === "anchored-to-message") this.#maintainAnchor();
        else if (this.autoScroll && this.#mode === "following-bottom") this.scrollToEnd("auto");
        else this.#updateScrollState();
      });
    });
    this.#resizeObserver.observe(this.#viewport);
    this.#resizeObserver.observe(this.#content);
  }

  #disconnectResizeObserver() {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#resizeFrame !== undefined) cancelAnimationFrame(this.#resizeFrame);
    this.#resizeFrame = undefined;
    if (this.#initialPositionTimer !== undefined) clearTimeout(this.#initialPositionTimer);
    this.#initialPositionTimer = undefined;
    this.#clearAutoscrolling();
  }
}

export function MessageScroller(
  handle: Handle<MessageScrollerProps, MessageScrollerController>,
) {
  const controller = new MessageScrollerController();
  handle.context.set(controller);

  return () => {
    const {
      autoScroll = false,
      defaultScrollPosition = "end",
      mix,
      scrollPreviousItemPeek = 64,
      ...props
    } = handle.props;
    controller.configure(autoScroll, defaultScrollPosition, scrollPreviousItemPeek);
    handle.queueTask(() => controller.reconcile());

    return (
      <div
        {...props}
        data-slot="message-scroller"
        mix={[
          messageScrollerStyle,
          ref((node, signal) => controller.attachRoot(node, signal)),
          mix,
        ]}
      />
    );
  };
}

export function MessageScrollerViewport(handle: Handle<Props<"div">>) {
  const controller = handle.context.get(MessageScroller);
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <div
        role="region"
        aria-label="Messages"
        tabIndex={0}
        {...props}
        data-slot="message-scroller-viewport"
        mix={[
          messageScrollerViewportStyle,
          ref((node, signal) => controller.attachViewport(node, signal)),
          on("scroll", () => controller.onScroll()),
          on("wheel", () => controller.onUserIntent()),
          on("touchmove", () => controller.onUserIntent()),
          on("keydown", (event) => controller.onKeyDown(event.key)),
          mix,
        ]}
      />
    );
  };
}

export function MessageScrollerContent(handle: Handle<Props<"div">>) {
  const controller = handle.context.get(MessageScroller);
  return () => {
    const { children, mix, ...props } = handle.props;
    return (
      <div
        role="log"
        aria-relevant="additions"
        {...props}
        data-slot="message-scroller-content"
        mix={[
          messageScrollerContentStyle,
          ref((node, signal) => controller.attachContent(node, signal)),
          mix,
        ]}
      >
        {children}
        <div
          aria-hidden="true"
          data-message-scroller-spacer
          mix={messageScrollerSpacerStyle}
        />
      </div>
    );
  };
}

export function MessageScrollerItem(handle: Handle<MessageScrollerItemProps>) {
  return () => {
    const { messageId, mix, scrollAnchor = false, ...props } = handle.props;
    return (
      <div
        {...props}
        data-slot="message-scroller-item"
        data-message-id={messageId}
        data-scroll-anchor={String(scrollAnchor)}
        mix={[messageScrollerItemStyle, mix]}
      />
    );
  };
}

export function MessageScrollerButton(handle: Handle<MessageScrollerButtonProps>) {
  const controller = handle.context.get(MessageScroller);
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <Button
        {...props}
        type="button"
        variant="secondary"
        size="icon-sm"
        aria-label="Scroll to latest message"
        title="Scroll to latest message"
        inert
        tabIndex={-1}
        data-slot="message-scroller-button"
        data-direction="end"
        data-active="false"
        mix={[
          messageScrollerButtonStyle,
          ref((node, signal) => controller.attachButton(node, signal)),
          on("click", (event) => {
            if (event.currentTarget.inert) return;
            event.currentTarget.blur();
            controller.scrollToEnd();
          }),
          mix,
        ]}
      >
        <Icon name="arrow-down" />
        <span mix={screenReaderOnlyStyle}>Scroll to latest message</span>
      </Button>
    );
  };
}

const messageScrollerStyle = css({
  position: "relative",
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
});

const messageScrollerViewportStyle = css({
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  overscrollBehavior: "contain",
  scrollbarGutter: "stable",
  scrollbarWidth: "thin",
  contain: "content",
  outline: "none",
  maskImage:
    "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 40px), transparent 100%)",
  "&:focus-visible": {
    boxShadow: "inset 0 0 0 2px var(--ring)",
  },
  "&[data-autoscrolling]": { scrollbarWidth: "none" },
  "&[data-autoscrolling]::-webkit-scrollbar": { display: "none" },
});

const messageScrollerContentStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: `${CONTENT_GAP_PX}px`,
  width: "min(100%, 800px)",
  minHeight: "100%",
  height: "max-content",
  marginInline: "auto",
  padding: "32px 24px 96px",
});

const messageScrollerItemStyle = css({
  flexShrink: 0,
  minWidth: 0,
  contentVisibility: "auto",
  containIntrinsicSize: "auto 10rem",
});

const messageScrollerSpacerStyle = css({
  flex: "0 0 auto",
  height: 0,
  marginTop: `-${CONTENT_GAP_PX}px`,
  pointerEvents: "none",
});

const messageScrollerButtonStyle = css({
  position: "absolute",
  bottom: "16px",
  left: "50%",
  zIndex: 2,
  color: "var(--foreground)",
  background: "var(--background)",
  border: "1px solid var(--border)",
  boxShadow: "0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  opacity: 1,
  translate: "-50% 0",
  scale: "1",
  transition: "translate 200ms, scale 200ms, opacity 200ms",
  "&:hover": { color: "var(--foreground)", background: "var(--muted)" },
  "&[data-active='false']": {
    pointerEvents: "none",
    opacity: 0,
    translate: "-50% 100%",
    scale: "0.95",
    transitionDuration: "400ms",
    transitionTimingFunction: "cubic-bezier(0.7, 0, 0.84, 0)",
  },
  "&[data-active='true']": {
    transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
  },
});

const screenReaderOnlyStyle = css({
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
});
