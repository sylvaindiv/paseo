import { diffRows, applyPatch, type Rows, type Entity } from "../shared/things.js";
import type { FolderBoard } from "./folder-store.js";
import { makeTask, initialProjects, initialKeys } from "./priority-prototype.js";

export function boardProjects(board: FolderBoard): NonNullable<FolderBoard["thingsProjects"]> {
  return (
    board.thingsProjects ??
    initialProjects.map((project, i) => ({
      id: "p:" + initialKeys[i],
      name: project.name,
      workspace: initialKeys[i],
    }))
  );
}
export function projectStatusKey(project: ReturnType<typeof boardProjects>[number]) {
  return project.id.startsWith("p:things:") || project.id.startsWith("p:local:")
    ? project.id
    : project.workspace || project.id;
}
export function boardRows(board: FolderBoard): Rows {
  const result: Rows = {};
  boardProjects(board).forEach((p, i) => {
    const status = board.projectStatuses?.[projectStatusKey(p)];
    result[p.id] = {
      id: p.id,
      kind: "project",
      parent: null,
      title: p.name,
      ...(p.notes ? { notes: p.notes } : {}),
      done: status === "Terminé",
    };
    const phaseKeys = new Map<number, string>();
    for (const phase of board.phases[i] ?? []) {
      const id = phase.thingsKey ?? p.id + "/h:" + phase.id;
      phaseKeys.set(phase.id, id);
      if (phase.id !== -1) result[id] = { id, kind: "phase", parent: p.id, title: phase.name };
    }
    for (const task of board.items.filter((t) => t.project === i)) {
      const id = "t:" + task.id;
      result[id] = {
        id,
        kind: "task",
        parent: task.phase === -1 ? p.id : (phaseKeys.get(task.phase) ?? p.id),
        title: task.title,
        notes: task.note ?? "",
        done: task.status === 3,
      };
      for (const child of task.children) {
        const key = id + "/s:" + child.id;
        result[key] = { id: key, kind: "child", parent: id, title: child.title, done: child.done };
      }
    }
  });
  return result;
}
export function updateBoard(board: FolderBoard, sent: Rows, rows: Entity[]): FolderBoard {
  const received = Object.fromEntries(rows.map((r) => [r.id, r]));
  const current = boardRows(board),
    merged = { ...current };
  for (const edit of diffRows(sent, received)) {
    const id = (edit.after ?? edit.before)!.id;
    // Edits made during the RPC are still pending in IndexedDB and go out on the next exchange.
    const next = applyPatch(current[id] ?? null, edit, () => {});
    if (next) merged[id] = next;
    else delete merged[id];
  }
  const priorProjects = boardProjects(board);
  const projects = priorProjects.filter((p) => merged[p.id]);
  const phases = projects.map((p) => [
    ...(board.phases[priorProjects.findIndex((previous) => previous.id === p.id)] ?? []),
  ]);
  const projectStatuses = { ...board.projectStatuses };
  // Existing array positions preserve the user's manual order.
  for (const row of Object.values(merged).filter((r) => r.kind === "project")) {
    let i = projects.findIndex((p) => p.id === row.id);
    if (i < 0) {
      i = projects.length;
      projects.push({ id: row.id, name: row.title, workspace: "" });
      phases.push([]);
    }
    projects[i] = { ...projects[i]!, name: row.title, notes: row.notes };
    const key = projectStatusKey(projects[i]!);
    if (row.done) projectStatuses[key] = "Terminé";
    else if (projectStatuses[key] === "Terminé") delete projectStatuses[key];
  }
  const groups = new Map<string, { project: number; phase: number }>();
  for (const [i, p] of projects.entries()) {
    groups.set(p.id, { project: i, phase: -1 });
    const entries = Object.values(merged).filter((r) => r.kind === "phase" && r.parent === p.id);
    const prior = phases[i] ?? [];
    const all: FolderBoard["phases"][number] = entries.map((row) => {
      const phase = Number(row.id.slice(row.id.lastIndexOf("/h:") + 3));
      groups.set(row.id, { project: i, phase });
      return { id: phase, name: row.title, thingsKey: row.id };
    });
    const order = new Map(prior.map((r, j) => [r.id, j]));
    all.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    if (Object.values(merged).some((r) => r.kind === "task" && r.parent === p.id))
      all.unshift({ id: -1, name: "Sans section" });
    phases[i] = all;
  }
  const byTask = new Map(board.items.map((t) => ["t:" + t.id, t]));
  const items = Object.values(merged)
    .filter((r) => r.kind === "task")
    .flatMap((row) => {
      const group = groups.get(row.parent ?? "");
      if (!group) return [];
      const previous =
        byTask.get(row.id) ??
        makeTask(Number(row.id.slice(2)), group.project, group.phase, row.title, 0, 0);
      const children = Object.values(merged)
        .filter((r) => r.kind === "child" && r.parent === row.id)
        .map((r) => ({ id: r.id.slice((row.id + "/s:").length), title: r.title, done: !!r.done }));
      const openStatus = previous.status === 3 ? 0 : previous.status;
      return [
        {
          ...previous,
          ...group,
          title: row.title,
          note: row.notes ?? "",
          status: row.done ? 3 : openStatus,
          children,
        },
      ];
    });
  // A non-shared project retains its board, including images and agent data.
  return {
    ...board,
    items,
    phases,
    projectStatuses,
    thingsProjects: projects,
    thingsBase: received,
  };
}

export function updateProjectMetadata(
  board: FolderBoard,
  id: string,
  patch: { name?: string; notes?: string; workspace?: string },
) {
  const projects = [...boardProjects(board)];
  const i = projects.findIndex((p) => p.id === id);
  if (i < 0) return projects;
  projects[i] = { ...projects[i]!, ...patch };
  return projects;
}
