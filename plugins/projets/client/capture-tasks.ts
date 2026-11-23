import { boardProjects } from "./things-board.js";
import type { CaptureReply } from "../shared/task-capture.js";
import type { FolderBoard } from "./folder-store.js";
import { makeTask, newFolderId, type Task } from "./priority-prototype.js";

export function captureContext(board: FolderBoard) {
  return boardProjects(board).map((p, project) => ({
    project,
    name: p.name,
    phases: board.phases[project],
    tasks: board.items
      .filter((t) => t.project === project)
      .map((t) => ({
        id: t.id,
        title: t.title,
        phase: t.phase,
        subtasks: t.children.map((c) => c.title),
      })),
  }));
}
const key = (title: string) => title.trim().toLocaleLowerCase("fr");
export function addCapturedTasks(
  board: FolderBoard,
  reply: CaptureReply,
  selected: number | null,
  images: File[],
) {
  const next = { ...board, items: [...board.items], phases: board.phases.map((p) => [...p]) };
  for (const draft of reply.tasks) {
    const phases = next.phases[draft.project];
    if (!phases || (selected !== null && selected !== draft.project))
      throw new Error("Projet à préciser.");
    if (!phases.length && draft.phase === null) phases.push({ id: newFolderId(), name: "À faire" });
    const existing =
      draft.existing === null
        ? next.items.find((t) => t.project === draft.project && key(t.title) === key(draft.title))
        : next.items.find((t) => t.project === draft.project && t.id === draft.existing);
    if (draft.existing !== null && !existing) throw new Error("La tâche à compléter a changé.");
    const phase = existing?.phase ?? draft.phase ?? phases[0]?.id;
    if (!phases.some((p) => p.id === phase) || phase === undefined)
      throw new Error("La phase a changé. Précise où ajouter la tâche.");
    const task = existing ?? makeTask(newFolderId(), draft.project, phase, draft.title, 0, 0);
    const item = mergeDetails(task, draft, images);
    if (existing) next.items[next.items.indexOf(existing)] = item;
    else next.items.push(item);
  }
  return next;
}

function mergeDetails(task: Task, draft: CaptureReply["tasks"][number], images: File[]) {
  const children = [...task.children];
  for (const title of draft.subtasks)
    if (!children.some((c) => key(c.title) === key(title)))
      children.push({ id: crypto.randomUUID(), title, done: false });
  const files = [...(task.images ?? [])];
  for (const i of new Set(draft.images)) {
    const file = images[i];
    if (!file) throw new Error("Image introuvable dans la conversation.");
    if (
      !files.some(
        (f) =>
          f.file.name === file.name &&
          f.file.lastModified === file.lastModified &&
          f.file.size === file.size,
      )
    )
      files.push({ id: newFolderId(), file });
  }
  const notes = (task.note ?? "").split("\n\n");
  const note = draft.note.trim();
  if (note && !notes.includes(note)) notes.push(note);
  return { ...task, children, images: files, note: notes.filter(Boolean).join("\n\n") };
}
