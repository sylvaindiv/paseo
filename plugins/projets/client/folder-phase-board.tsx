/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Local interactions in the Dossiers prototype. */
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ProjectMenu } from "./project-menu.js";
import { projectStyles } from "./styles.js";
import {
  SortableTitleBar,
  SortableTitleProvider,
  titleDragAttributes,
  useBoardSensors,
} from "./sortable-controls.js";
import { collisionsUnderPointer, taskBoardKeyboardCoordinates } from "./task-drag.js";

export interface FolderPhase {
  thingsKey?: string;
  id: number;
  name: string;
}
export interface PhaseAction {
  project: number;
  phase?: FolderPhase;
  mode: "add" | "rename" | "delete";
}

export function FolderDragBoard({
  phases,
  end,
  children,
}: {
  phases: FolderPhase[];
  end(event: DragEndEvent): void;
  children: ReactNode;
}) {
  const keys = useMemo(() => phases.map((p) => "phase:" + p.id), [phases]);
  const sensors = useBoardSensors(taskBoardKeyboardCoordinates);
  return (
    <DndContext sensors={sensors} collisionDetection={collisionsUnderPointer} onDragEnd={end}>
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function FolderTask({ id, children }: { id: number; children: ReactNode }) {
  const sortable = useSortable({ id: "task:" + id, attributes: titleDragAttributes });
  const { transform, transition } = sortable;
  const style = useMemo(
    () => ({ transform: CSS.Translate.toString(transform), transition }),
    [transform, transition],
  );
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className="folderTask"
      data-task-id={id}
      data-moving={sortable.isDragging || undefined}
    >
      <SortableTitleProvider sortable={sortable}>{children}</SortableTitleProvider>
    </div>
  );
}

export function FolderSection({
  phase,
  label,
  taskIds,
  action,
  colors,
  children,
}: {
  phase: FolderPhase;
  label: ReactNode;
  taskIds: string[];
  action(mode: "rename" | "delete"): void;
  colors: PluginScreenProps["theme"]["colors"];
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const sortable = useSortable({ id: "phase:" + phase.id, attributes: titleDragAttributes });
  const { transform, transition } = sortable;
  const style = useMemo(
    () => ({ transform: CSS.Translate.toString(transform), transition }),
    [transform, transition],
  );
  const menu = useMemo(() => {
    function act(mode: "rename" | "delete") {
      setAnchor(undefined);
      action(mode);
    }
    return [
      { label: "Renommer", icon: "Pencil", onPress: () => act("rename") },
      { label: "Supprimer", icon: "Trash2", onPress: () => act("delete") },
    ];
  }, [action]);
  return (
    <section
      className="folderPhase"
      ref={sortable.setNodeRef}
      style={style}
      data-phase-id={phase.id}
      data-moving={sortable.isDragging || undefined}
      data-over={sortable.isOver || undefined}
    >
      <div className="folderPhaseBar">
        <SortableTitleProvider sortable={sortable}>
          <SortableTitleBar label={"Déplacer la phase " + phase.name}>{label}</SortableTitleBar>
        </SortableTitleProvider>
        <button
          type="button"
          className="folderAction"
          aria-label={"Actions de la phase " + phase.name}
          aria-haspopup="menu"
          aria-expanded={!!anchor}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          ⋯
        </button>
        {anchor && (
          <ProjectMenu
            anchor={anchor}
            title={phase.name}
            label={"Actions de la phase " + phase.name}
            close={() => setAnchor(undefined)}
            pending={false}
            styles={projectStyles}
            colors={colors}
            items={menu}
          />
        )}
      </div>
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </section>
  );
}

export function PhaseDialog({
  action,
  projectName,
  count,
  close,
  apply,
}: {
  action: PhaseAction;
  projectName: string;
  count: number;
  close(): void;
  apply(name: string): Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(action.phase?.name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const remove = action.mode === "delete";
  const title = {
    add: "Ajouter une phase",
    rename: "Renommer la phase",
    delete: "Supprimer la phase ?",
  }[action.mode];
  useLayoutEffect(() => {
    const element = ref.current;
    element?.showModal();
    element?.querySelector("input")?.select();
    return () => element?.close();
  }, []);
  return (
    <dialog
      className="phaseDialog"
      ref={ref}
      aria-labelledby="phase-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pending || (!remove && !name.trim())) return;
          setPending(true);
          setError(false);
          void apply(name.trim()).catch(() => {
            setPending(false);
            setError(true);
          });
        }}
      >
        <small>{projectName}</small>
        <h2 id="phase-dialog-title">{title}</h2>
        {remove ? (
          <p>
            La phase « {action.phase?.name} » sera supprimée.
            {count > 0 && (
              <strong>
                {" "}
                {count} tâche{count > 1 ? "s" : ""} et {count > 1 ? "leurs" : "ses"} sous-tâches
                seront aussi supprimées.
              </strong>
            )}
          </p>
        ) : (
          <label>
            Nom de la phase
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        {error && <p role="alert">Modification non enregistrée. Réessaie.</p>}
        <div>
          <button type="button" disabled={pending} onClick={close}>
            Annuler
          </button>
          <button
            className={remove ? "danger" : "primary"}
            type="submit"
            disabled={pending || (!remove && !name.trim())}
          >
            {remove ? "Supprimer" : title}
          </button>
        </div>
      </form>
    </dialog>
  );
}
