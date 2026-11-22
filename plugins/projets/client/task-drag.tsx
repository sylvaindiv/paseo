import {
  DndContext,
  DragOverlay,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { createPortal } from "react-dom";
import { CSS } from "@dnd-kit/utilities";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import type { ProjectPhase, ProjectTask } from "../shared/project-todos.js";
import type { Change } from "./inline-todo.js";
import {
  liveCollisions,
  SortableTitleProvider,
  titleDragAttributes,
  useBoardSensors,
} from "./sortable-controls.js";
import { projectColors, type ProjectStyles } from "./styles.js";

const HighlightContext = createContext<string | undefined>(undefined);
const QueueDragContext = createContext(false);
const queueDropId = "projets:queue";
const web = Platform.OS === "web";

function phaseKey(phaseId: string) {
  return "phase:" + phaseId;
}

export const taskBoardKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (!String(args.active).startsWith("phase:")) return sortableKeyboardCoordinates(event, args);
  if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
  event.preventDefault();
  const { collisionRect, droppableContainers, droppableRects, over } = args.context;
  if (!collisionRect) return;
  const phases = droppableContainers
    .getEnabled()
    .flatMap(({ id }) => {
      const rect = droppableRects.get(id);
      return String(id).startsWith("phase:") && rect ? [{ id, rect }] : [];
    })
    .sort((a, b) => a.rect.top - b.rect.top);
  const index = phases.findIndex(({ id }) => id === (over?.id ?? args.active));
  const next = phases[index + (event.code === "ArrowDown" ? 1 : -1)];
  if (!next || index < 0) return;
  return {
    x: args.currentCoordinates.x,
    y: next.rect.top + (next.rect.height - collisionRect.height) / 2,
  };
};

export const collisionsUnderPointer: CollisionDetection = (args) => {
  const phaseDrag = String(args.active.id).startsWith("phase:");
  const droppableContainers = phaseDrag
    ? args.droppableContainers.filter(({ id }) => String(id).startsWith("phase:"))
    : args.droppableContainers;
  const hits = liveCollisions({ ...args, droppableContainers });
  if (phaseDrag) return hits;
  const task = hits.find((hit) => !String(hit.id).startsWith("phase:"));
  return task ? [task] : hits;
};

export function TaskDragBoard(props: {
  phases: ProjectPhase[];
  groups: Map<string, ProjectTask[]>;
  queueBlocked: ReadonlySet<string>;
  write(change: Change): Promise<void>;
  styles: ProjectStyles;
  children: ReactNode;
}) {
  return web ? <WebTaskDragBoard {...props} /> : props.children;
}

function WebTaskDragBoard({
  phases,
  groups,
  queueBlocked,
  write,
  styles,
  children,
}: Parameters<typeof TaskDragBoard>[0]) {
  const [active, setActive] = useState<ProjectTask>();
  const [highlight, setHighlight] = useState<string>();
  const toast = useToast();
  const sensors = useBoardSensors(taskBoardKeyboardCoordinates);
  const queueDrag = Boolean(active && !queueBlocked.has(active.id));
  const phaseKeys = useMemo(() => phases.map((phase) => phaseKey(phase.id)), [phases]);
  const { phaseByDrop, activeById } = useMemo(() => {
    const phaseForId = new Map<string, string>();
    const tasksById = new Map<string, ProjectTask>();
    for (const phase of phases) {
      phaseForId.set(phaseKey(phase.id), phase.id);
      for (const task of groups.get(phase.id) ?? []) {
        if (task.completed) continue;
        phaseForId.set(task.id, phase.id);
        tasksById.set(task.id, task);
      }
    }
    return { phaseByDrop: phaseForId, activeById: tasksById };
  }, [groups, phases]);
  const start = useCallback(
    (event: DragStartEvent) => {
      setActive(activeById.get(String(event.active.id)));
    },
    [activeById],
  );
  const over = useCallback(
    (event: DragOverEvent) => {
      const source = phaseByDrop.get(String(event.active.id));
      const targetId = String(event.over?.id);
      const target = targetId === queueDropId ? queueDropId : phaseByDrop.get(targetId);
      setHighlight(
        !String(event.active.id).startsWith("phase:") && target !== source ? target : undefined,
      );
    },
    [phaseByDrop],
  );
  const cancel = useCallback(() => {
    setActive(undefined);
    setHighlight(undefined);
  }, []);
  const end = useCallback(
    ({ active: source, over: target }: DragEndEvent) => {
      cancel();
      const sourceId = String(source.id);
      const targetId = String(target?.id);
      const from = phaseByDrop.get(sourceId);
      if (
        targetId === queueDropId &&
        from &&
        !sourceId.startsWith("phase:") &&
        !queueBlocked.has(sourceId)
      ) {
        void write({ operation: "queue-task", taskId: sourceId, queued: true }).catch(() =>
          toast.error("Tâche non ajoutée"),
        );
        return;
      }
      const to = phaseByDrop.get(targetId);
      if (!from || !to || sourceId === targetId) return;
      if (sourceId.startsWith("phase:")) {
        void write({ operation: "phase-reorder", phaseId: from, overPhaseId: to }).catch(() =>
          toast.error("Ordre des phases non enregistré"),
        );
        return;
      }
      if (from !== to) {
        void write({ operation: "phase-move", taskId: sourceId, phaseId: to }).catch(() =>
          toast.error("Déplacement non enregistré"),
        );
        return;
      }
      const ids = (groups.get(from) ?? []).filter((task) => !task.completed).map((task) => task.id);
      const fromIndex = ids.indexOf(sourceId);
      const toIndex = ids.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) return;
      void write({ operation: "reorder", ids: arrayMove(ids, fromIndex, toIndex) }).catch(() =>
        toast.error("Déplacement non enregistré"),
      );
    },
    [cancel, groups, phaseByDrop, queueBlocked, toast, write],
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionsUnderPointer}
      onDragStart={start}
      onDragOver={over}
      onDragEnd={end}
      onDragCancel={cancel}
    >
      <HighlightContext.Provider value={highlight}>
        <QueueDragContext.Provider value={queueDrag}>
          <SortableContext items={phaseKeys} strategy={verticalListSortingStrategy}>
            {children}
          </SortableContext>
        </QueueDragContext.Provider>
      </HighlightContext.Provider>
      {web &&
        createPortal(
          <DragOverlay dropAnimation={null}>
            {active ? (
              <View style={styles.dragPreview}>
                <Text style={styles.inlineTitle}>{active.title}</Text>
                {active.subtasks.slice(0, 3).map((child) => (
                  <Text key={child.id} style={styles.small}>
                    {child.title}
                  </Text>
                ))}
              </View>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
}

export function TaskQueueDrop({
  children,
}: {
  children(dragging: boolean, over: boolean): ReactNode;
}) {
  return web ? <WebTaskQueueDrop>{children}</WebTaskQueueDrop> : children(false, false);
}

function WebTaskQueueDrop({ children }: Parameters<typeof TaskQueueDrop>[0]) {
  const dragging = useContext(QueueDragContext);
  const { setNodeRef, isOver } = useDroppable({ id: queueDropId, disabled: !dragging });
  return <div ref={setNodeRef}>{children(dragging, isOver)}</div>;
}

export function TaskDropPhase({
  id,
  tasks,
  canReorder,
  children,
}: {
  id: string;
  canReorder: boolean;
  tasks: ProjectTask[];
  children: ReactNode;
}) {
  return web ? (
    <WebTaskDropPhase id={id} tasks={tasks} canReorder={canReorder}>
      {children}
    </WebTaskDropPhase>
  ) : (
    children
  );
}

function WebTaskDropPhase({
  id,
  tasks,
  canReorder,
  children,
}: Parameters<typeof TaskDropPhase>[0]) {
  const disabled = useMemo(() => ({ draggable: !canReorder, droppable: false }), [canReorder]);
  const sortable = useSortable({ id: phaseKey(id), disabled, attributes: titleDragAttributes });
  const { setNodeRef, transform, transition, isDragging } = sortable;
  const highlighted = useContext(HighlightContext) === id;
  const items = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const outline = useMemo(
    () => ({
      outline: highlighted ? `2px solid ${projectColors.borderStrong}` : undefined,
      borderRadius: 14,
      transform: CSS.Translate.toString(transform),
      transition,
      zIndex: isDragging ? 1 : undefined,
    }),
    [highlighted, isDragging, transform, transition],
  );
  return (
    <div ref={setNodeRef} style={outline} data-projets-drop-phase={id}>
      <SortableTitleProvider sortable={sortable}>
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </SortableTitleProvider>
    </div>
  );
}

export function SortableTask({ id, children }: { id: string; children: ReactNode }) {
  return web ? <WebSortableTask id={id}>{children}</WebSortableTask> : children;
}

const sortableAttributes = { role: "group", tabIndex: -1 };

function WebSortableTask({ id, children }: Parameters<typeof SortableTask>[0]) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    attributes: sortableAttributes,
  });
  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.3 : 1,
      cursor: isDragging ? "grabbing" : "grab",
    }),
    [isDragging, transform, transition],
  );
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} data-projets-sortable={id}>
      {children}
    </div>
  );
}
