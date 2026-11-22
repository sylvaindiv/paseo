import {
  closestCenter,
  getClientRect,
  KeyboardSensor,
  pointerWithin,
  PointerSensor,
  TouchSensor,
  useSensors,
  useSensor,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates, type useSortable } from "@dnd-kit/sortable";
import { createContext, useContext, type ReactNode } from "react";
import { Platform } from "react-native";
import { projectColors } from "./styles.js";

export const titleDragAttributes = { role: "group" };
export const titleActionWebProps = Platform.OS === "web" ? { dataSet: { noDnd: "" } } : undefined;

function isControl(event: Event) {
  if (!(event.target instanceof Element)) return false;
  if (event.target.closest("[data-no-dnd]")) return true;
  if (event.target.closest(".projets-title-drag-region")) return false;
  return (
    event.target.closest(
      "button:not([data-testid^=projets-label-]),[role=button]:not([data-projets-sortable]):not([data-testid^=projets-label-]),[role=checkbox],input,textarea",
    ) !== null
  );
}

class BoardPointerSensor extends PointerSensor {
  static override activators: typeof PointerSensor.activators = [
    {
      eventName: "onPointerDown",
      handler: (event, options) =>
        event.nativeEvent.pointerType !== "touch" &&
        !isControl(event.nativeEvent) &&
        PointerSensor.activators[0]!.handler(event, options),
    },
  ];
}

class BoardTouchSensor extends TouchSensor {
  static override activators: typeof TouchSensor.activators = [
    {
      eventName: "onTouchStart",
      handler: (event, options) =>
        !isControl(event.nativeEvent) && TouchSensor.activators[0]!.handler(event, options),
    },
  ];
}

export function useBoardSensors(
  coordinateGetter: KeyboardCoordinateGetter = sortableKeyboardCoordinates,
) {
  return useSensors(
    useSensor(BoardPointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(BoardTouchSensor, { activationConstraint: { delay: 500, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );
}

export const liveCollisions: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);
  // The surface can sit inside a scrolling, translated pane.
  const droppableRects = new Map(
    args.droppableContainers.flatMap(({ id, node }) =>
      node.current ? [[id, getClientRect(node.current, { ignoreTransform: true })]] : [],
    ),
  );
  return pointerWithin({ ...args, droppableRects });
};

type Sortable = ReturnType<typeof useSortable>;
const TitleSortContext = createContext<Sortable | null>(null);

export function SortableTitleProvider({
  sortable,
  children,
}: {
  sortable: Sortable;
  children: ReactNode;
}) {
  return <TitleSortContext.Provider value={sortable}>{children}</TitleSortContext.Provider>;
}

export function SortableTitleBar({ label, children }: { label: string; children: ReactNode }) {
  const sortable = useContext(TitleSortContext);
  if (!sortable?.listeners) return children;
  return (
    <div
      className="projets-title-drag-region"
      {...sortable.attributes}
      {...sortable.listeners}
      ref={sortable.setActivatorNodeRef}
      aria-label={label}
      data-dragging={sortable.isDragging || undefined}
    >
      {children}
    </div>
  );
}

export function SortableTitleStyles() {
  if (Platform.OS !== "web") return null;
  return (
    <style>{`
      [data-testid="projets-board"][data-panning], [data-testid="projets-board"][data-panning] * {
        cursor: grabbing !important;
      }
      .projets-title-drag-region, .projets-title-drag-region [role="button"]:not([data-no-dnd]) {
        cursor: grab;
        user-select: none;
      }
      .projets-title-drag-region:focus-visible {
        outline: 2px solid ${projectColors.borderStrong};
        outline-offset: -2px;
        border-radius: 8px;
      }
      .projets-title-drag-region[data-dragging], .projets-title-drag-region[data-dragging] [role="button"]:not([data-no-dnd]) {
        cursor: grabbing;
      }
    `}</style>
  );
}
