import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, mock } from "node:test";
import init, {
  Viewer,
  ViewerFailure,
  describe_display,
} from "../../../../crates/viewer/pkg/madori_viewer.js";
import { loadViewerModule } from "./wasm.ts";
import { ViewportSession } from "./viewport-session.ts";

function deferred<T>() {
  const state: { resolve: (value: T) => void; reject: (reason: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
  });
  return { ...state, promise };
}

void test("session owns its canvas, frees aborted creation, reports idle loss and disposes once", async () => {
  await assert.rejects(loadViewerModule());
  await init({
    module_or_path: await readFile(
      new URL("../../../../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url),
    ),
  });
  await loadViewerModule();
  const children = new Set<EventTarget>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let disconnected = 0;
  class Canvas extends EventTarget {
    setPointerCapture = mock.fn<(id: number) => void>();
    remove() {
      children.delete(this);
    }
    getBoundingClientRect() {
      return { width: 640, height: 480 };
    }
  }
  class Host {
    append(canvas: EventTarget) {
      children.add(canvas);
    }
  }
  const globals = {
    document: { createElement: (tag: string) => (tag === "canvas" ? new Canvas() : new Host()) },
    window: new EventTarget(),
    devicePixelRatio: 2,
    ResizeObserver: class {
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const lost = deferred<void>();
  let freed = 0;
  let draws = 0;
  const viewer = {
    free: () => {
      freed++;
    },
    device_lost: () => lost.promise,
    resize: mock.fn<(width: number, height: number, scale: number) => void>(),
    orbit: mock.fn<(dx: number, dy: number) => void>(),
    pan: mock.fn<(dx: number, dy: number) => void>(),
    reset_view: mock.fn<() => void>(),
    zoom() {},
    show: () => ({ free() {} }),
    draw: () => {
      draws++;
      return true;
    },
  };
  const opening = deferred<typeof viewer>();
  const began = deferred<void>();
  const create = mock.method(Viewer, "create", () => {
    began.resolve();
    return opening.promise;
  });
  try {
    const host = document.createElement("div");
    const rejectedCreation = deferred<typeof viewer>();
    create.mock.mockImplementation(() => rejectedCreation.promise);
    const rejectedController = new AbortController();
    const rejected = ViewportSession.open(host, rejectedController.signal, () => assert.fail());
    await Promise.resolve();
    await Promise.resolve();
    let failure: unknown;
    try {
      describe_display(new Uint8Array([0]));
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof ViewerFailure);
    let failureFrees = 0;
    const freeFailure = mock.method(failure, "free", () => {
      failureFrees++;
    });
    rejectedController.abort();
    rejectedCreation.reject(failure);
    await assert.rejects(rejected, { name: "AbortError" });
    assert.equal(failureFrees, 1);
    freeFailure.mock.restore();
    failure.free();
    create.mock.mockImplementation(() => {
      began.resolve();
      return opening.promise;
    });
    const cancelled = new AbortController();
    const late = ViewportSession.open(host, cancelled.signal, () =>
      assert.fail("aborted session reported failure"),
    );
    await began.promise;
    cancelled.abort();
    opening.resolve(viewer);
    await assert.rejects(late, { name: "AbortError" });
    assert.equal(freed, 1);
    assert.equal(children.size, 0);
    create.mock.mockImplementation(() => Promise.resolve(viewer));
    const failures: unknown[] = [];
    const active = await ViewportSession.open(host, new AbortController().signal, (error) =>
      failures.push(error),
    );
    assert.deepEqual(
      viewer.resize.mock.calls.map((c) => c.arguments),
      [[640, 480, 2]],
    );
    const [canvas] = children;
    assert(canvas instanceof Canvas);
    const drag = (button: number, shiftKey = false) => {
      for (const [type, x, y] of [
        ["pointerdown", 10, 20],
        ["pointermove", 40, 15],
        ["pointerup", 40, 15],
      ] as const) {
        canvas.dispatchEvent(
          Object.assign(new Event(type), {
            pointerId: 1,
            clientX: x,
            clientY: y,
            button,
            shiftKey: type === "pointerdown" && shiftKey,
            ctrlKey: false,
          }),
        );
      }
    };
    drag(0);
    assert.deepEqual(
      viewer.orbit.mock.calls.map((c) => c.arguments),
      [[30, -5]],
    );
    assert.equal(viewer.pan.mock.callCount(), 0);
    drag(2);
    assert.equal(viewer.pan.mock.callCount(), 1);
    drag(0, true);
    assert.equal(viewer.pan.mock.callCount(), 2);
    drag(1);
    assert.deepEqual(
      viewer.pan.mock.calls.map((c) => c.arguments),
      [
        [30, -5],
        [30, -5],
      ],
    );
    assert.equal(viewer.orbit.mock.callCount(), 1);
    const menu = new Event("contextmenu", { cancelable: true });
    canvas.dispatchEvent(menu);
    assert(menu.defaultPrevented);
    active.show(new Uint8Array([1]));
    const drawFrames = () => {
      for (const [id, callback] of frames) {
        frames.delete(id);
        callback(0);
      }
    };
    drawFrames();
    assert.equal(draws, 1);
    assert.equal(frames.size, 0);
    assert.equal(children.size, 1);
    active.resetView();
    assert.equal(viewer.reset_view.mock.callCount(), 1);
    assert.equal(frames.size, 1);
    drawFrames();
    assert.equal(draws, 2);
    const loss = new Error("device lost while idle");
    lost.reject(loss);
    await Promise.resolve();
    assert.deepEqual(failures, [loss]);
    assert.equal(children.size, 0);
    assert.equal(freed, 2);
    assert.equal(disconnected, 1);
    const earlyFailures: unknown[] = [];
    const alreadyLost = await ViewportSession.open(host, new AbortController().signal, (error) =>
      earlyFailures.push(error),
    );
    assert(alreadyLost.disposed, "completion must not mark a disposed session ready");
    assert.deepEqual(earlyFailures, [loss]);
    active.dispose();
    active.resetView();
    assert.equal(viewer.reset_view.mock.callCount(), 1);
    active.show(new Uint8Array([1]));
    assert.equal(freed, 3);
    assert.equal(frames.size, 0);
  } finally {
    create.mock.restore();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
