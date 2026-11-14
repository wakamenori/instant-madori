import { ViewerFailure } from "./wasm.ts";
import type { Viewer } from "./wasm.ts";
import { loadViewerModule } from "./wasm.ts";
import { dragDelta, wheelSteps } from "./gestures.ts";

/** One canvas per session isolates asynchronous StrictMode mounts. */
export class ViewportSession {
  readonly #viewer: Viewer;
  readonly #canvas: HTMLCanvasElement;
  readonly #events = new AbortController();
  readonly #observer: ResizeObserver;
  readonly #onFailure: (error: unknown) => void;
  #frame = 0;
  #disposed = false;
  private constructor(
    viewer: Viewer,
    canvas: HTMLCanvasElement,
    onFailure: (error: unknown) => void,
  ) {
    this.#viewer = viewer;
    this.#canvas = canvas;
    this.#onFailure = onFailure;
    void viewer.device_lost().catch((error: unknown) => {
      if (this.#disposed) {
        if (error instanceof ViewerFailure) error.free();
        return;
      }
      this.#onFailure(error);
      this.dispose();
    });
    const options = { signal: this.#events.signal };
    let previous: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || previous) return;
        previous = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      },
      options,
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!previous || previous.id !== event.pointerId) return;
        const next = { id: event.pointerId, x: event.clientX, y: event.clientY };
        const delta = dragDelta(previous, next);
        previous = next;
        this.#viewer.orbit(delta.dx, delta.dy);
        this.#requestFrame();
      },
      options,
    );
    const end = (event: PointerEvent) => {
      if (previous?.id === event.pointerId) previous = null;
    };
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const)
      canvas.addEventListener(name, end, options);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.#viewer.zoom(wheelSteps(event), event.offsetX, event.offsetY);
        this.#requestFrame();
      },
      { ...options, passive: false },
    );
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      this.#viewer.resize(
        Math.round(width * devicePixelRatio),
        Math.round(height * devicePixelRatio),
      );
      this.#requestFrame();
    };
    this.#observer = new ResizeObserver(resize);
    this.#observer.observe(canvas);
    window.addEventListener("resize", resize, options);
    resize();
  }
  static async open(
    host: HTMLElement,
    signal: AbortSignal,
    onFailure: (error: unknown) => void,
  ): Promise<ViewportSession> {
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    host.append(canvas);
    let viewer: Viewer | undefined;
    try {
      const module = await loadViewerModule();
      signal.throwIfAborted();
      viewer = await module.Viewer.create(canvas);
      signal.throwIfAborted();
      return new ViewportSession(viewer, canvas, onFailure);
    } catch (error) {
      if (signal.aborted && error instanceof ViewerFailure) error.free();
      viewer?.free();
      canvas.remove();
      signal.throwIfAborted();
      throw error;
    }
  }
  get disposed(): boolean {
    return this.#disposed;
  }
  show(display: Uint8Array): void {
    if (this.#disposed) return;
    try {
      const summary = this.#viewer.show(display);
      summary.free();
      this.#requestFrame();
    } catch (error) {
      this.#onFailure(error);
    }
  }
  #requestFrame() {
    if (this.#frame || this.#disposed) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      try {
        if (!this.#viewer.draw()) this.#requestFrame();
      } catch (error) {
        this.#onFailure(error);
      }
    });
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    this.#events.abort();
    this.#observer.disconnect();
    this.#viewer.free();
    this.#canvas.remove();
  }
}
