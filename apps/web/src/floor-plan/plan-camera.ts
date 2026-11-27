import type { ElementId, ViewBox } from "./plan-svg.ts";
export type Camera = { zoom: number; centerX: number; centerY: number };
export type Size = { width: number; height: number };
type Point = { x: number; y: number };

export function fitCamera(box: ViewBox): Camera {
  return { zoom: 1, centerX: box.x + box.width / 2, centerY: box.y + box.height / 2 };
}
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
function bounded(box: ViewBox, camera: Camera): Camera {
  return {
    ...camera,
    centerX: clamp(camera.centerX, box.x, box.x + box.width),
    centerY: clamp(camera.centerY, box.y, box.y + box.height),
  };
}
export function viewBoxOf(box: ViewBox, camera: Camera, size: Size | null): ViewBox {
  const aspect =
    size && size.width > 0 && size.height > 0 ? size.width / size.height : box.width / box.height;
  const width = Math.max(box.width, box.height * aspect) / camera.zoom;
  const height = width / aspect;
  const { centerX, centerY } = bounded(box, camera);
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}
export function zoomBy(camera: Camera, factor: number): Camera {
  return { ...camera, zoom: clamp(camera.zoom * factor, 1, 20) };
}
export function zoomAt(
  box: ViewBox,
  camera: Camera,
  size: Size,
  steps: number,
  point: Point,
): Camera {
  const current = bounded(box, camera);
  const next = zoomBy(current, Math.exp(-steps * 0.002));
  const before = viewBoxOf(box, current, size);
  const ratio = 1 - current.zoom / next.zoom;
  return bounded(box, {
    zoom: next.zoom,
    centerX: current.centerX + (point.x / size.width - 0.5) * before.width * ratio,
    centerY: current.centerY + (point.y / size.height - 0.5) * before.height * ratio,
  });
}
export function panBy(box: ViewBox, camera: Camera, size: Size, dx: number, dy: number): Camera {
  const current = bounded(box, camera);
  const scale = viewBoxOf(box, current, size).width / size.width;
  return bounded(box, {
    ...current,
    centerX: current.centerX - dx * scale,
    centerY: current.centerY - dy * scale,
  });
}
export type Press =
  | { kind: "idle" }
  | { kind: "pressed"; pointer: number; start: Point; hit: ElementId | null }
  | { kind: "panning"; pointer: number; last: Point };
export type PressEvent =
  | { kind: "down"; pointer: number; at: Point; primary: boolean; hit: ElementId | null }
  | { kind: "move" | "up"; pointer: number; at: Point }
  | { kind: "cancel"; pointer: number };
export type PressEffect =
  | { kind: "none" }
  | { kind: "select"; element: ElementId | null }
  | { kind: "pan"; dx: number; dy: number };
export function press(state: Press, event: PressEvent): { state: Press; effect: PressEffect } {
  const unchanged = { state, effect: { kind: "none" as const } };
  if (event.kind === "down") {
    if (state.kind !== "idle" || !event.primary) return unchanged;
    return {
      state: { kind: "pressed", pointer: event.pointer, start: event.at, hit: event.hit },
      effect: { kind: "none" },
    };
  }
  if (state.kind === "idle" || state.pointer !== event.pointer) return unchanged;
  if (event.kind === "cancel") return { state: { kind: "idle" }, effect: { kind: "none" } };
  const last = state.kind === "pressed" ? state.start : state.last;
  const dx = event.at.x - last.x,
    dy = event.at.y - last.y;
  if (state.kind === "pressed" && Math.hypot(dx, dy) <= 4) {
    return event.kind === "up"
      ? { state: { kind: "idle" }, effect: { kind: "select", element: state.hit } }
      : unchanged;
  }
  return {
    state:
      event.kind === "up"
        ? { kind: "idle" }
        : { kind: "panning", pointer: event.pointer, last: event.at },
    effect: { kind: "pan", dx, dy },
  };
}
