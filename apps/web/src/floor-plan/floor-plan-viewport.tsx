import {
  createElement,
  useRef,
  useState,
  useEffect,
  type ReactElement,
  type PointerEvent,
} from "react";
import {
  selectableAt,
  type ElementId,
  type FloorPlan,
  type PlanNode,
  type ViewBox,
} from "./plan-svg.ts";
import {
  fitCamera,
  zoomBy,
  zoomAt,
  panBy,
  viewBoxOf,
  press,
  type Press,
  type PressEvent,
  type Size,
  type Camera,
} from "./plan-camera.ts";
import type { PlanSlot } from "../project-session.ts";
import { wheelSteps } from "../viewer/gestures.ts";

export function PlanSvg({
  plan,
  selected,
  viewBox,
}: {
  plan: FloorPlan;
  selected: ElementId | null;
  viewBox: ViewBox;
}) {
  function render(node: PlanNode, key: number): ReactElement {
    const props: Record<string, unknown> = { ...node.props, key };
    if (node === plan.root)
      props.viewBox = [viewBox.x, viewBox.y, viewBox.width, viewBox.height].join(" ");
    if (node.element && node.element === selected)
      props.className = [node.props.className, "selected"].filter(Boolean).join(" ");
    if (node.dimensionsFor && node.dimensionsFor !== selected) props.display = "none";
    return createElement(
      node.tag,
      props,
      node.children.map((child, index) =>
        typeof child === "string" ? child : render(child, index),
      ),
    );
  }
  return render(plan.root, 0);
}

export function FloorPlanViewport({ slot }: { slot: PlanSlot | null }) {
  const frame = useRef<HTMLDivElement>(null);
  const gesture = useRef<Press>({ kind: "idle" });
  const [size, setSize] = useState<Size | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [picked, setPicked] = useState<ElementId | null>(null);
  const plan = slot?.kind === "ready" ? slot.plan : null;
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = frame.current;
    if (!el || !plan) return;
    function wheel(e: WheelEvent) {
      if (!el || !plan) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      e.preventDefault();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setCamera((c) => zoomAt(plan.viewBox, c ?? fitCamera(plan.viewBox), rect, wheelSteps(e), at));
    }
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [plan]);
  function handle(event: PressEvent) {
    const result = press(gesture.current, event);
    gesture.current = result.state;
    const effect = result.effect;
    if (effect.kind === "select") setPicked(effect.element);
    if (effect.kind === "pan" && plan && size && size.width > 0 && size.height > 0)
      setCamera((c) =>
        panBy(plan.viewBox, c ?? fitCamera(plan.viewBox), size, effect.dx, effect.dy),
      );
  }
  function pointer(e: PointerEvent) {
    return { pointer: e.pointerId, at: { x: e.clientX, y: e.clientY } };
  }
  function scale(factor: number) {
    if (plan) setCamera((c) => zoomBy(c ?? fitCamera(plan.viewBox), factor));
  }
  return (
    <>
      <div className="plan-container">
        <div
          ref={frame}
          className="viewport plan-frame"
          role="group"
          aria-label="間取り図"
          tabIndex={0}
          onPointerDown={(e) => {
            if (!plan || !e.isPrimary || e.button !== 0 || gesture.current.kind !== "idle") return;
            const target =
              e.target instanceof Element ? e.target.closest("[data-element-id]") : null;
            handle({
              kind: "down",
              ...pointer(e),
              primary: true,
              hit: selectableAt(plan, target?.getAttribute("data-element-id") ?? null),
            });
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => handle({ kind: "move", ...pointer(e) })}
          onPointerUp={(e) => handle({ kind: "up", ...pointer(e) })}
          onLostPointerCapture={(e) => handle({ kind: "cancel", pointer: e.pointerId })}
          onPointerCancel={(e) => handle({ kind: "cancel", pointer: e.pointerId })}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPicked(null);
          }}
        >
          {plan && (
            <PlanSvg
              plan={plan}
              selected={selectableAt(plan, picked)}
              viewBox={viewBoxOf(plan.viewBox, camera ?? fitCamera(plan.viewBox), size)}
            />
          )}
          {slot?.kind === "absent" && <p role="status">この案には間取り図がありません。</p>}
          {slot?.kind === "rejected" && (
            <p role="alert">この案の間取り図を表示できませんでした。</p>
          )}
        </div>
        {plan && (
          <div className="viewport-reset plan-controls">
            <button onClick={() => scale(1.25)}>拡大</button>
            <button onClick={() => scale(0.8)}>縮小</button>
            <button onClick={() => setCamera(null)}>全体を表示</button>
          </div>
        )}
      </div>
      {plan && (
        <p className="note">
          ドラッグで移動、ホイールで拡大・縮小。部屋か壁を押すと寸法を表示します。
        </p>
      )}
    </>
  );
}
