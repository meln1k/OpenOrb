import type { CodeView as PierreCodeView, CodeViewItem, CodeViewOptions } from "@pierre/diffs";
import { css, type Handle, on, type Props, ref } from "remix/ui";

export type RemixCodeViewProps = Omit<Props<"nav">, "children"> & {
  readonly CodeView: typeof PierreCodeView | undefined;
  readonly items: readonly CodeViewItem[];
  readonly options?: CodeViewOptions<undefined>;
  readonly onViewerClick?: (event: MouseEvent, viewer: PierreCodeView) => void;
};

export function RemixCodeView(handle: Handle<RemixCodeViewProps>) {
  let host: HTMLElement | undefined;
  let viewer: PierreCodeView | undefined;
  let mountedCodeView: typeof PierreCodeView | undefined;
  let appliedItems: readonly CodeViewItem[] | undefined;
  let appliedOptions: CodeViewOptions<undefined> | undefined;

  const cleanViewer = () => {
    viewer?.cleanUp();
    viewer = undefined;
    mountedCodeView = undefined;
    appliedItems = undefined;
    appliedOptions = undefined;
    host?.replaceChildren();
  };

  const synchronizeItems = () => {
    const currentViewer = viewer;
    const items = handle.props.items;
    if (currentViewer === undefined || items === appliedItems) return;
    currentViewer.setItems(items);
    appliedItems = items;
  };

  const ensureViewer = () => {
    const CodeView = handle.props.CodeView;
    if (host === undefined || CodeView === undefined) {
      if (viewer !== undefined) cleanViewer();
      return;
    }
    if (viewer === undefined || mountedCodeView !== CodeView) {
      cleanViewer();
      const nextViewer = new CodeView(handle.props.options);
      nextViewer.setup(host);
      viewer = nextViewer;
      mountedCodeView = CodeView;
      appliedOptions = handle.props.options;
    } else if (appliedOptions !== handle.props.options) {
      viewer.setOptions(handle.props.options);
      appliedOptions = handle.props.options;
    }
    synchronizeItems();
  };

  const attachHost = (node: HTMLElement, signal: AbortSignal) => {
    host = node;
    ensureViewer();
    signal.addEventListener("abort", () => {
      if (host !== node) return;
      cleanViewer();
      host = undefined;
    }, { once: true });
  };

  const handleClick = (event: MouseEvent) => {
    if (viewer !== undefined) handle.props.onViewerClick?.(event, viewer);
  };

  handle.signal.addEventListener("abort", cleanViewer, { once: true });

  return () => {
    const constructorChanged = mountedCodeView !== handle.props.CodeView;
    if (
      host !== undefined &&
      (constructorChanged ||
        handle.props.CodeView !== undefined &&
          (appliedItems !== handle.props.items || appliedOptions !== handle.props.options))
    ) {
      handle.queueTask(ensureViewer);
    }
    const {
      CodeView: _CodeView,
      items: _items,
      options: _options,
      onViewerClick: _onViewerClick,
      mix,
      ...props
    } = handle.props;
    return (
      <nav
        {...props}
        innerHTML=""
        mix={[
          codeViewRootStyle,
          mix,
          ref(attachHost),
          on<HTMLElement, "click">("click", handleClick),
        ]}
      />
    );
  };
}

const codeViewRootStyle = css({
  display: "block",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
});
