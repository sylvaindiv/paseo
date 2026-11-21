import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { useCallback, useMemo, type ReactNode } from "react";
import { Platform } from "react-native";
import {
  liveCollisions,
  SortableTitleProvider,
  titleDragAttributes,
  useBoardSensors,
} from "./sortable-controls.js";

export function ProjectDragRow(props: {
  keys: string[];
  move(from: string, to: string): void;
  children: ReactNode;
}) {
  return Platform.OS === "web" ? <WebProjectDragRow {...props} /> : props.children;
}

function WebProjectDragRow({ keys, move, children }: Parameters<typeof ProjectDragRow>[0]) {
  const sensors = useBoardSensors();
  const end = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (over && active.id !== over.id) move(String(active.id), String(over.id));
    },
    [move],
  );
  return (
    <DndContext sensors={sensors} collisionDetection={liveCollisions} onDragEnd={end}>
      <SortableContext items={keys} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function SortableProject(props: { id: string; disabled: boolean; children: ReactNode }) {
  return Platform.OS === "web" ? <WebSortableProject {...props} /> : props.children;
}

function WebSortableProject({ id, disabled, children }: Parameters<typeof SortableProject>[0]) {
  const sortable = useSortable({ id, disabled, attributes: titleDragAttributes });
  const { isDragging, setNodeRef, transform, transition } = sortable;
  const style = useMemo(
    () => ({
      flex: "none",
      transform: CSS.Translate.toString(transform),
      transition,
      zIndex: isDragging ? 1 : undefined,
    }),
    [isDragging, transform, transition],
  );
  return (
    <div ref={setNodeRef} style={style}>
      <SortableTitleProvider sortable={sortable}>{children}</SortableTitleProvider>
    </div>
  );
}
