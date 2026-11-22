/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Local dialog interactions. */
import { TaskCapture } from "./task-capture.js";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { currentProjectPhase, type OverviewPhase } from "../shared/project-todos.js";
import type { FolderBoard, FolderStore } from "./folder-store.js";

const statusChoices = ["À planifier", "En cours", "En attente", "Terminé"];

function phaseStatus(tasks: FolderBoard["items"]): OverviewPhase["status"] {
  if (!tasks.length) return null;
  if (tasks.every((task) => task.status === 3)) return "OK";
  if (tasks.some((task) => task.status !== 0)) return "EN COURS";
  return "À PLANNIFIER";
}

function PhaseSummary({ board, project }: { board: FolderBoard; project: number }) {
  const phases = board.phases[project].map((phase) => {
    const tasks = board.items.filter((task) => task.project === project && task.phase === phase.id);
    const completed = tasks.filter((task) => task.status === 3).length;
    const progress = tasks.length ? completed + "/" + tasks.length : "Sans tâche";
    return { ...phase, status: phaseStatus(tasks), progress, label: phase.name + " · " + progress };
  });
  const current = currentProjectPhase(phases);
  if (!current) return <span className="phaseSummary">Aucune phase</span>;
  return (
    <div className="phaseSummary">
      <span>{current.label}</span>
      <span className="overviewTrack" role="img" aria-label={phases.map((p) => p.label).join(", ")}>
        {phases.map((p) => (
          <i key={p.id} data-state={p.status} title={p.label} />
        ))}
      </span>
    </div>
  );
}

export function FolderOverview({
  hostId,
  board,
  store,
  projects,
  projectKeys,
  order,
}: {
  hostId: string;
  board: FolderBoard;
  store: FolderStore;
  projects: readonly { name: string }[];
  projectKeys: readonly string[];
  order: readonly number[];
}) {
  const [captureOpen, setCaptureOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [titleBar, setTitleBar] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // The host owns the screen title. Limit the lookup to this mounted screen.
    let ancestor = dialog.current?.parentElement;
    while (ancestor) {
      const title = ancestor.querySelector<HTMLElement>(
        '[data-projects-window-title], [data-testid="plugin-surface-title"]',
      );
      if (title?.parentElement) {
        setTitleBar(title.parentElement);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }, []);
  function openOverview() {
    const node = dialog.current;
    if (!node) return;
    const top = node.closest(".priorityDemo")?.getBoundingClientRect().top ?? 0;
    node.style.setProperty("--overview-top", Math.max(0, top) + "px");
    node.showModal();
  }
  const actions = (
    <>
      <button
        type="button"
        className="projectsOverviewTrigger projectsHeaderAction"
        aria-haspopup="dialog"
        onClick={openOverview}
      >
        Aperçu
      </button>
      <button
        type="button"
        className="projectsHeaderAction"
        aria-haspopup="dialog"
        onClick={() => setCaptureOpen(true)}
      >
        + Tâches
      </button>
    </>
  );
  return (
    <div className="folderOverview">
      {titleBar ? createPortal(actions, titleBar) : actions}
      {captureOpen && <TaskCapture hostId={hostId} close={() => setCaptureOpen(false)} />}
      <dialog
        ref={dialog}
        aria-label="Aperçu des projets"
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX > r.right ||
            e.clientX < r.left ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            dialog.current?.close();
        }}
      >
        <div className="overviewHead">
          <h2>Aperçu des projets</h2>
          <button
            type="button"
            aria-label="Fermer l’aperçu"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        {order.map((project) => {
          const key = projectKeys[project];
          const status = board.projectStatuses?.[key] ?? "";
          return (
            <div className="overviewRow" key={key}>
              <div>
                <strong>{projects[project].name}</strong>
                <PhaseSummary board={board} project={project} />
              </div>
              <select
                aria-label={"Statut du projet " + projects[project].name}
                data-status={status}
                value={status}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  store.edit((current) => ({
                    ...current,
                    projectStatuses: { ...current.projectStatuses, [key]: value },
                  }));
                }}
              >
                <option value="">Sans statut</option>
                {statusChoices.map((label) => (
                  <option key={label}>{label}</option>
                ))}
              </select>
            </div>
          );
        })}
        {store.get().error && <p role="alert">{store.get().error}</p>}
      </dialog>
    </div>
  );
}
