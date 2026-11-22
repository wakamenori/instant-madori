export type DragKind = "orbit" | "pan";
export function dragKind(event: {
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}): DragKind | null {
  if (event.button === 0) return event.shiftKey || event.ctrlKey ? "pan" : "orbit";
  return event.button === 2 ? "pan" : null;
}
interface PointerSample {
  x: number;
  y: number;
}
export function dragDelta(previous: PointerSample, next: PointerSample) {
  return {
    dx: next.x - previous.x,
    dy: next.y - previous.y,
  };
}
export function wheelSteps(event: { deltaY: number; deltaMode: number }): number {
  return event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
}
