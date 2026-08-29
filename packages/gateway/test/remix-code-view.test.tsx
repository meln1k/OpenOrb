import { assertEquals } from "@std/assert";
import {
  type Context,
  type FrameContent,
  type FrameHandle,
  type FrameHandleEventMap,
  type Handle,
  TypedEventTarget,
} from "remix/ui";

import { RemixCodeView, type RemixCodeViewProps } from "@/app/ui/components/remix-code-view.tsx";

Deno.test("RemixCodeView gives Pierre ownership of the host contents", () => {
  const controller = new AbortController();
  const frame = createFrameHandle();
  const handle: Handle<RemixCodeViewProps> = {
    id: "changes",
    props: { CodeView: undefined, items: [] },
    context: new EmptyContext(),
    update: () => Promise.resolve(controller.signal),
    queueTask: () => undefined,
    frame,
    frames: { top: frame, get: () => undefined },
    signal: controller.signal,
  };

  const host = RemixCodeView(handle)();

  assertEquals(host.props.innerHTML, "");
  controller.abort();
});

class EmptyContext implements Context<Record<string, never>> {
  set(_values: Record<string, never>): void {}

  get<ComponentType>(_component: ComponentType): never {
    throw new Error("The CodeView wrapper does not read context");
  }
}

function createFrameHandle(): FrameHandle {
  return Object.assign(new TypedEventTarget<FrameHandleEventMap>(), {
    src: "http://localhost/",
    reload: () => Promise.resolve(AbortSignal.abort()),
    replace: (_content: FrameContent) => Promise.resolve(),
  });
}
