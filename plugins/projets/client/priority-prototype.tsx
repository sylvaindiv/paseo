/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Interactive design study with local fixtures. */
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ImageTile, type TaskImage } from "./task-image.js";
import { arrayMove, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ProjectDragRow } from "./project-drag.js";
import { cardCss } from "./project-card-style.js";
import type { DragEndEvent } from "@dnd-kit/core";
import { ProjectIcon } from "@getpaseo/plugin/client/ui";
import { useProjects, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SortableTitleBar } from "./sortable-controls.js";
import {
  FolderTask,
  FolderDragBoard,
  FolderSection,
  PhaseDialog,
  type FolderPhase,
  type PhaseAction,
} from "./folder-phase-board.js";
import { priorityCss } from "./priority-prototype-style.js";

import { boardProjects, updateProjectMetadata } from "./things-board.js";
import { ThingsConnection } from "./things-connection.js";
import { createFolderStore } from "./folder-store.js";
import {
  FolderDispatch,
  findBoardProjectHost,
  running,
  useFolderTracking,
  type FolderRun,
} from "./folder-dispatch.js";

import { FolderOverview } from "./folder-overview.js";

export const initialProjects = [
  { name: "CVC Detailing", phases: ["Contrôle du site", "Photos"] },
  { name: "Nature et Création", phases: ["Première vitrine", "Référencement"] },
  { name: "Pars Agere", phases: ["Cadrage", "Accueil HTML", "Poseidon"] },
];
const statuses = ["À faire", "En cours", "À vérifier", "Terminée"];
interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  run?: FolderRun;
  id: number;
  project: number;
  phase: number;
  title: string;
  status: number;
  tag: number;
  children: Subtask[];
  note?: string;
  images?: TaskImage[];
  agent: { title: string; children: string[] } | null;
}
export function makeTask(
  id: number,
  project: number,
  phase: number,
  title: string,
  status: number,
  tag: number,
  children: string[] = [],
): Task {
  return {
    id,
    project,
    phase,
    title,
    status,
    tag,
    children: children.map((name, i) => ({ id: id + "-" + i, title: name, done: false })),
    agent: null,
  };
}
const tasks = [
  makeTask(1, 0, 0, "Vérifier que toutes les pages existent", 0, 0, [
    "Comparer le menu au plan du site",
    "Lister les pages manquantes",
  ]),
  makeTask(2, 0, 0, "Tester le fonctionnement des pages", 2, 1, [
    "Tester les liens",
    "Envoyer le formulaire de contact",
  ]),
  makeTask(3, 0, 1, "Associer les photos aux bonnes pages", 0, 2),
  makeTask(4, 1, 0, "Faire le point sur l’existant", 1, 0),
  makeTask(5, 1, 0, "Lister ce qui manque à la vitrine", 0, 0),
  makeTask(6, 1, 0, "Décider de la mise en ligne", 0, 1),
  makeTask(7, 1, 1, "Préparer le référencement", 0, 3),
  makeTask(8, 2, 0, "Extraire l’essentiel du brief", 0, 0),
  makeTask(9, 2, 1, "Créer l’accueil en HTML simple", 0, 1),
  makeTask(10, 2, 1, "Valider la page d’accueil", 0, 0),
  makeTask(11, 2, 2, "Reprendre le site sur Poseidon", 0, 1),
];

function Checklist({ task, change }: { task: Task; change(patch: Partial<Task>): void }) {
  return (
    <div className="children">
      {task.children.map((child) => (
        <label className="childline" key={child.id}>
          <input
            type="checkbox"
            checked={child.done}
            onChange={(e) =>
              change({
                children: task.children.map((c) =>
                  c.id === child.id ? { ...c, done: e.target.checked } : c,
                ),
              })
            }
          />
          <span title={child.title}>{child.title}</span>
        </label>
      ))}
    </div>
  );
}

function SubtaskEditor({ task, change }: { task: Task; change(children: Subtask[]): void }) {
  const [nextId, setNextId] = useState(() => crypto.randomUUID());
  const list = useRef<HTMLDivElement>(null);
  function rename(child: Subtask, title: string) {
    if (child.id !== nextId) {
      change(task.children.map((c) => (c.id === child.id ? { ...c, title } : c)));
    } else if (title) {
      // Keep the same keyed input as the draft becomes a real subtask.
      change([...task.children, { ...child, title }]);
      setNextId(crypto.randomUUID());
    }
  }
  return (
    <div className="editChildren" ref={list}>
      {[...task.children, { id: nextId, title: "", done: false }].map((child, i) => (
        <div className="editChild" key={child.id}>
          {child.id === nextId ? (
            <span className="childPlus" aria-hidden="true">
              ＋
            </span>
          ) : (
            <input
              type="checkbox"
              aria-label={"Terminer " + child.title}
              checked={child.done}
              onChange={(e) =>
                change(
                  task.children.map((c) =>
                    c.id === child.id ? { ...c, done: e.target.checked } : c,
                  ),
                )
              }
            />
          )}
          <input
            className="childTitle"
            aria-label={child.id === nextId ? "Nouvelle sous-tâche" : "Sous-tâche " + (i + 1)}
            value={child.title}
            placeholder={child.id === nextId ? "Ajouter une sous-tâche…" : "Sous-tâche"}
            onChange={(e) => rename(child, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                list.current?.querySelectorAll<HTMLInputElement>(".childTitle")[i + 1]?.focus();
              }
            }}
          />
          {child.id !== nextId && (
            <button
              type="button"
              className="removeChild"
              aria-label={"Supprimer " + child.title}
              title="Supprimer la sous-tâche"
              onClick={() => change(task.children.filter((c) => c.id !== child.id))}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function TaskDrawer({ children, close }: { children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="overlay taskDrawer"
      aria-label="Modifier la tâche"
      onCancel={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          close();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sheet">{children}</div>
    </dialog>
  );
}

function CompactTask({
  task,
  change,
  open,
}: {
  task: Task;
  change(patch: Partial<Task>): void;
  open(): void;
}) {
  return (
    <div className="compactTask">
      <div className="compactLine">
        <input
          type="checkbox"
          aria-label={"Terminer " + task.title}
          disabled={running(task.run)}
          checked={task.status === 3}
          onChange={(e) => change({ status: e.target.checked ? 3 : 0 })}
        />
        <SortableTitleBar label={"Déplacer la tâche " + task.title}>
          <button type="button" className="compactTitle" onClick={open} title={task.title}>
            {task.title}
          </button>
        </SortableTitleBar>
        <select
          className={"compactStatus s" + task.status}
          disabled={running(task.run)}
          aria-label={"Statut de " + task.title}
          value={task.status}
          onChange={(e) => change({ status: Number(e.target.value) })}
        >
          {statuses.map((label, i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {task.children.length > 0 && <Checklist task={task} change={change} />}
    </div>
  );
}

function TaskExtras({ task, change }: { task: Task; change(patch: Partial<Task>): void }) {
  const images = task.images ?? [];
  function attach(files: FileList) {
    const additions = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!additions.length) return;
    const next = 1 + Math.max(0, ...images.map((image) => image.id));
    change({ images: [...images, ...additions.map((file, i) => ({ file, id: next + i }))] });
  }
  return (
    <div
      className="extras"
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
          e.preventDefault();
          attach(e.clipboardData.files);
        }
      }}
    >
      <label className="field">
        Note
        <textarea
          value={task.note ?? ""}
          placeholder="Ajouter une note…"
          onChange={(e) => change({ note: e.target.value })}
        />
      </label>
      <label className="attach">
        ＋ Images
        <input
          aria-label="Ajouter des images"
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => {
            if (e.target.files) attach(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {images.length > 0 && (
        <div className="gallery">
          {images.map((image) => (
            <ImageTile
              key={image.id}
              image={image}
              remove={() => change({ images: images.filter((entry) => entry.id !== image.id) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  name,
  hostId,
  projectId,
  first,
  children,
  onAddPhase,
}: {
  project: number;
  name: string;
  hostId: string;
  projectId?: string;
  first: boolean;
  children: ReactNode;
  onAddPhase?: () => void;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition } =
    useSortable({ id: String(project) });
  const style = useMemo(
    () => ({ transform: CSS.Translate.toString(transform), transition }),
    [transform, transition],
  );
  return (
    <article data-project={project} ref={setNodeRef} style={style} className={first ? "lead" : ""}>
      <header>
        <h2>
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={"Déplacer " + name}
            className="projectTitle projets-title-drag-region"
          >
            {projectId && (
              <span className="projectIcon" aria-hidden="true">
                <ProjectIcon serverId={hostId} projectId={projectId} size={23} />
              </span>
            )}
            <span className="projectName">{name}</span>
          </button>
        </h2>
        {onAddPhase && (
          <button
            type="button"
            className="folderAction folderAdd"
            aria-label={"Ajouter une phase à " + name}
            title="Ajouter une phase"
            onClick={onAddPhase}
          >
            ＋
          </button>
        )}
      </header>
      {children}
    </article>
  );
}

export function newFolderId() {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi! & 0x1fffff) * 0x100000000 + lo!;
}

export const initialKeys = [
  "remote:github.com/sylvaindiv/cvc-detailing",
  "remote:github.com/sylvaindiv/studio-nature-et-creation-v2",
  "Pars-agere",
];
const emptyTaskIds: string[] = [];
export const initialBoard = {
  items: tasks,
  phases: initialProjects.map((p) => p.phases.map((name, id) => ({ name, id }))),
};

export function ProjectsBoard({
  colors,
  hostId,
  navigation,
}: {
  hostId: string;
  navigation: PluginScreenProps["navigation"];
  colors: PluginScreenProps["theme"]["colors"];
}) {
  const directory = useProjects();
  const store = useMemo(() => createFolderStore(hostId, initialBoard), [hostId]);
  const saved = useSyncExternalStore(store.subscribe, store.get);
  const projects = useMemo(() => boardProjects(saved.board), [saved.board]);
  const projectKeys = useMemo(() => projects.map((p) => p.workspace || p.id), [projects]);
  const { items, phases: phaseLists } = saved.board;
  const record = useFolderTracking(saved.board.items, store);
  function setItems(edit: (all: Task[]) => Task[]) {
    store.edit((board) => ({ ...board, items: edit(board.items) }));
  }
  const [phaseAction, setPhaseAction] = useState<PhaseAction | null>(null);
  const [manualOrder, setOrder] = useState<number[]>([]);
  const order = useMemo(
    () => [
      ...new Set([...manualOrder.filter((i) => i < projects.length), ...projects.map((_, i) => i)]),
    ],
    [manualOrder, projects],
  );
  const keys = useMemo(() => order.map(String), [order]);
  const taskIdsByPhase = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const task of items) {
      const key = task.project + "-" + task.phase;
      const group = groups.get(key);
      if (group) group.push("task:" + task.id);
      else groups.set(key, ["task:" + task.id]);
    }
    return groups;
  }, [items]);
  const [opened, selectTask] = useState<number | null>(null);
  const [folded, setFolded] = useState<string[]>([]);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const active = items.find((t) => t.id === opened);
  function reorder(from: string, to: string) {
    setOrder(() => arrayMove(order, order.indexOf(Number(from)), order.indexOf(Number(to))));
  }
  function update(id: number, patch: Partial<Task>) {
    setItems((current) =>
      current.map((t) => {
        if (t.id !== id || (patch.status !== undefined && running(t.run))) return t;
        return { ...t, ...patch };
      }),
    );
  }
  function add(p: number, phase: number) {
    const id = newFolderId();
    setItems((all) => [...all, makeTask(id, p, phase, "Nouvelle tâche", 0, 0)]);
    selectTask(id);
  }
  function phaseHeader(p: number, { id: i, name }: FolderPhase) {
    const key = p + "-" + i;
    return (
      <button
        type="button"
        className="phase"
        aria-expanded={!folded.includes(key)}
        onClick={() =>
          setFolded(folded.includes(key) ? folded.filter((x) => x !== key) : [...folded, key])
        }
      >
        <span>{folded.includes(key) ? "▸" : "▾"}</span>
        {name}
      </button>
    );
  }
  async function applyPhase(name: string) {
    if (!phaseAction) return;
    const { project, phase, mode } = phaseAction;
    const newId = newFolderId();
    await store.write((board) => ({
      ...board,
      items:
        mode === "delete"
          ? board.items.filter((t) => t.project !== project || t.phase !== phase?.id)
          : board.items,
      phases: board.phases.map((list, i) => {
        if (i !== project) return list;
        if (mode === "add") return [...list, { id: newId, name }];
        if (mode === "delete") return list.filter((f) => f.id !== phase?.id);
        return list.map((f) => (f.id === phase?.id ? { ...f, name } : f));
      }),
    }));
    setPhaseAction(null);
  }
  function drop(p: number, { active: source, over }: DragEndEvent) {
    if (!over || source.id === over.id) return;
    const [kind, from] = String(source.id).split(":");
    const [target, to] = String(over.id).split(":");
    if (kind === "phase") {
      store.edit((board) => ({
        ...board,
        phases: board.phases.map((list, i) =>
          i === p
            ? arrayMove(
                list,
                list.findIndex((f) => f.id === Number(from)),
                list.findIndex((f) => f.id === Number(to)),
              )
            : list,
        ),
      }));
      return;
    }
    setItems((all) => {
      const src = all.findIndex((t) => t.id === Number(from) && t.project === p);
      if (src < 0) return all;
      const dst =
        target === "task" ? all.findIndex((t) => t.id === Number(to) && t.project === p) : -1;
      const phase = dst < 0 ? Number(to) : all[dst].phase;
      if (!phaseLists[p].some((f) => f.id === phase)) return all;
      if (dst >= 0 && all[src].phase === phase) return arrayMove(all, src, dst);
      const moved = { ...all[src], phase };
      const rest = all.filter((t) => t.id !== moved.id);
      const at = dst < 0 ? rest.length : rest.indexOf(all[dst]);
      return [...rest.slice(0, at), moved, ...rest.slice(at)];
    });
  }
  function phaseTasks(p: number, i: number) {
    return (
      <>
        {items
          .filter((t) => t.project === p && t.phase === i)
          .map((t) => (
            <FolderTask key={t.id} id={t.id}>
              <CompactTask
                task={t}
                change={(patch) => update(t.id, patch)}
                open={() => selectTask(t.id)}
              />
            </FolderTask>
          ))}
        <button type="button" className="add" onClick={() => add(p, i)}>
          ＋ Tâche
        </button>
      </>
    );
  }
  function phases(p: number) {
    const list = phaseLists[p];
    return (
      <FolderDragBoard phases={list} end={(e) => drop(p, e)}>
        {list.map((phase) => (
          <FolderSection
            key={phase.id}
            phase={phase}
            label={phaseHeader(p, phase)}
            colors={colors}
            taskIds={taskIdsByPhase.get(p + "-" + phase.id) ?? emptyTaskIds}
            action={(mode) => setPhaseAction({ project: p, phase, mode })}
          >
            {!folded.includes(p + "-" + phase.id) && phaseTasks(p, phase.id)}
          </FolderSection>
        ))}
      </FolderDragBoard>
    );
  }
  function pan(e: PointerEvent<HTMLDivElement>) {
    if (
      e.pointerType !== "mouse" ||
      e.button !== 0 ||
      (e.target as HTMLElement).closest(
        "button,input,select,textarea,a,.projets-title-drag-region",
      ) ||
      !row.current ||
      row.current.scrollWidth <= row.current.clientWidth
    )
      return;
    drag.current = { x: e.clientX, left: row.current.scrollLeft };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function detail(t: Task) {
    return (
      <aside aria-label="Détail de la tâche" className="detail">
        <div className="detailtop">
          <small>
            {projects[t.project].name} / {phaseLists[t.project].find((f) => f.id === t.phase)?.name}
          </small>
          <button type="button" aria-label="Fermer le détail" onClick={() => selectTask(null)}>
            ×
          </button>
        </div>
        <div className="editTaskHeading">
          <textarea
            rows={1}
            placeholder="Titre de la tâche"
            aria-label="Titre de la tâche"
            value={t.title}
            onChange={(e) => update(t.id, { title: e.target.value })}
          />
          <select
            className={"compactStatus s" + t.status}
            disabled={running(t.run)}
            aria-label="Statut de la tâche"
            value={t.status}
            onChange={(e) => update(t.id, { status: Number(e.target.value) })}
          >
            {statuses.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <h3>Sous-tâches</h3>
        <SubtaskEditor key={t.id} task={t} change={(children) => update(t.id, { children })} />
        <TaskExtras task={t} change={(patch) => update(t.id, patch)} />

        <FolderDispatch
          key={"dispatch-" + t.id}
          hostId={hostId}
          project={projects[t.project].name}
          projectKey={projectKeys[t.project]!}
          task={t}
          store={store}
          navigation={navigation}
          record={record}
        />
      </aside>
    );
  }
  if (!saved.ready) return <p>{saved.error || "Chargement…"}</p>;
  return (
    <main className="priorityDemo carnet cardStudy original">
      <style>
        {priorityCss}
        {cardCss}
      </style>
      {saved.error && <p role="alert">{saved.error}</p>}
      <ThingsConnection store={store} hostId={hostId} />
      {projects.map(
        (p) =>
          (p.id.startsWith("p:things:") || p.id.startsWith("p:local:")) && (
            <label key={p.id}>
              {p.name} · Espace de travail{" "}
              <select
                value={p.workspace ?? ""}
                onChange={(event) => {
                  const workspace = event.currentTarget.value;
                  store.edit((board) => ({
                    ...board,
                    thingsProjects: updateProjectMetadata(board, p.id, { workspace }),
                  }));
                }}
              >
                <option value="">Choisir un projet Paseo</option>
                {directory.projects
                  .filter((entry) => entry.hosts.some((h) => h.serverId === hostId))
                  .map((entry) => (
                    <option key={entry.viewKey} value={entry.viewKey}>
                      {entry.projectName}
                    </option>
                  ))}
              </select>
            </label>
          ),
      )}
      <FolderOverview
        hostId={hostId}
        board={saved.board}
        store={store}
        projects={projects}
        order={order}
      />
      <div
        className="scrollArea"
        onPointerDown={pan}
        onPointerMove={(e) => {
          if (drag.current && row.current)
            row.current.scrollLeft = drag.current.left + drag.current.x - e.clientX;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div className="projectrow" ref={row}>
          <ProjectDragRow keys={keys} move={reorder}>
            {order.map((p, i) => {
              const target = findBoardProjectHost(directory.projects, hostId, projectKeys[p]);
              return (
                <ProjectCard
                  hostId={hostId}
                  projectId={target?.projectId}
                  onAddPhase={() => setPhaseAction({ project: p, mode: "add" })}
                  name={projects[p]!.name}
                  project={p}
                  first={i === 0}
                  key={p}
                >
                  {phases(p)}
                </ProjectCard>
              );
            })}
          </ProjectDragRow>
        </div>
      </div>
      {active && <TaskDrawer close={() => selectTask(null)}>{detail(active)}</TaskDrawer>}
      {phaseAction && (
        <PhaseDialog
          action={phaseAction}
          projectName={projects[phaseAction.project].name}
          count={
            items.filter(
              (t) => t.project === phaseAction.project && t.phase === phaseAction.phase?.id,
            ).length
          }
          close={() => setPhaseAction(null)}
          apply={applyPhase}
        />
      )}
    </main>
  );
}
