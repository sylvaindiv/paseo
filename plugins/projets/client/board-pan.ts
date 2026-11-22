import { useEffect, useRef } from "react";
import { Platform, type View } from "react-native";

const rowSelector = '[data-testid="projets-cards"],[data-testid="projets-finished"]';
const controlSelector = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[contenteditable=true]",
  "[role=button]",
  "[role=checkbox]",
  "[role=menu]",
  "[data-no-dnd]",
  ".projets-title-drag-region",
  "[data-projets-sortable]",
].join(",");

export function useBoardPan() {
  const board = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || !(board.current instanceof HTMLElement)) return;
    const surface = board.current;
    let drag: { row: HTMLElement; id: number; x: number; left: number } | null = null;

    function start(event: PointerEvent) {
      const target = event.target;
      if (event.pointerType !== "mouse" || event.button !== 0 || !(target instanceof HTMLElement))
        return;
      if (target.closest(controlSelector)) return;
      // Leave the browser's horizontal and vertical scrollbar thumbs draggable.
      const bounds = target.getBoundingClientRect();
      if (
        event.clientX >= bounds.left + target.clientLeft + target.clientWidth ||
        event.clientY >= bounds.top + target.clientTop + target.clientHeight
      )
        return;
      const row =
        target.closest<HTMLElement>(rowSelector) ?? surface.querySelector<HTMLElement>(rowSelector);
      if (!row || row.scrollWidth <= row.clientWidth) return;
      event.preventDefault();
      surface.setPointerCapture(event.pointerId);
      drag = { row, id: event.pointerId, x: event.clientX, left: row.scrollLeft };
      surface.dataset.panning = "";
    }

    function move(event: PointerEvent) {
      if (drag && event.pointerId === drag.id)
        drag.row.scrollLeft = drag.left + drag.x - event.clientX;
    }
    function end(event: PointerEvent) {
      if (event.pointerId !== drag?.id) return;
      drag = null;
      delete surface.dataset.panning;
      if (surface.hasPointerCapture(event.pointerId))
        surface.releasePointerCapture(event.pointerId);
    }
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    surface.addEventListener("pointerdown", start, options);
    surface.addEventListener("pointermove", move, options);
    surface.addEventListener("pointerup", end, options);
    surface.addEventListener("pointercancel", end, options);
    surface.addEventListener("lostpointercapture", end, options);
    return () => {
      listeners.abort();
      if (drag && surface.hasPointerCapture(drag.id)) surface.releasePointerCapture(drag.id);
      delete surface.dataset.panning;
    };
  }, []);
  return board;
}
