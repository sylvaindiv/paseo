import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { agentPrompt } from "../shared/agent-prompt.js";
import {
  projectTodoList,
  type BatchObservation,
  type ProjectTask,
  type ProjectTodoList,
  type writeProjectTodo,
} from "../shared/project-todos.js";

type Change = RpcInput<typeof writeProjectTodo>["change"];
type PhaseChange = Exclude<
  Extract<Change, { operation: `phase-${string}` }>,
  { operation: "phase-reorder" }
>;

function emptyList(): ProjectTodoList {
  return { phases: [{ id: "default", name: "Phase 1", order: 0 }], tasks: [] };
}

function requireTask(tasks: ProjectTask[], id: string) {
  const task = tasks.find((entry) => entry.id === id);
  if (!task) throw new Error("Tâche indisponible");
  return task;
}

function reassign(tasks: ProjectTask[], from: string, to: string) {
  for (const task of tasks) {
    if (task.stage === from) task.stage = to;
  }
}

function writePhase(list: ProjectTodoList, change: PhaseChange) {
  const phase = list.phases.find((entry) => entry.id === change.phaseId);
  const first = list.phases[0]!;
  if (change.operation === "phase-add") {
    if (phase) return;
    if (list.phases.some((item) => item.name === change.title))
      throw new Error("Nom de phase déjà utilisé");
    reassign(list.tasks, change.title, first.name);
    list.phases.push({
      id: change.phaseId,
      name: change.title,
      order: Math.max(...list.phases.map((item) => item.order)) + 1,
    });
    return;
  }

  if (!phase) throw new Error("Phase indisponible");
  switch (change.operation) {
    case "phase-rename":
      if (list.phases.some((item) => item !== phase && item.name === change.title))
        throw new Error("Nom de phase déjà utilisé");
      if (phase !== first && change.title !== phase.name)
        reassign(list.tasks, change.title, first.name);
      reassign(list.tasks, phase.name, change.title);
      phase.name = change.title;
      break;
    case "phase-status":
      phase.status = change.status;
      break;
    case "phase-delete":
      if (phase === first) throw new Error("La première phase est obligatoire");
      reassign(list.tasks, phase.name, first.name);
      list.phases = list.phases.filter((item) => item !== phase);
      break;
    case "phase-move": {
      const task = requireTask(list.tasks, change.taskId);
      if (task.stage === phase.name) break;
      task.stage = phase.name;
      list.tasks.splice(list.tasks.indexOf(task), 1);
      task.order = nextOrder(list.tasks);
      list.tasks.push(task);
      break;
    }
  }
}

function reorderPhases(list: ProjectTodoList, phaseId: string, overPhaseId: string) {
  const from = list.phases.findIndex((phase) => phase.id === phaseId);
  const to = list.phases.findIndex((phase) => phase.id === overPhaseId);
  if (from < 0 || to < 0) throw new Error("La liste des phases a changé");
  if (from === to) return;
  if (from === 0 || to === 0) {
    const first = list.phases[0]!;
    const known = new Set(list.phases.map((phase) => phase.name));
    for (const task of list.tasks) {
      if (task.stage === null || !known.has(task.stage)) task.stage = first.name;
    }
  }
  const [phase] = list.phases.splice(from, 1);
  list.phases.splice(to, 0, phase!);
  list.phases.forEach((entry, order) => {
    entry.order = order;
  });
}

function reorder(list: ProjectTodoList, ids: string[]) {
  const requested = new Set(ids);
  if (requested.size !== ids.length) throw new Error("La liste a changé");
  const moved = ids.map((id) => requireTask(list.tasks, id));
  let next = 0;
  list.tasks = list.tasks.map((task, order) => ({
    ...(requested.has(task.id) ? moved[next++]! : task),
    order,
  }));
}

function writeSubtask(
  task: ProjectTask,
  change: Extract<Change, { operation: `subtask-${string}` }>,
) {
  switch (change.operation) {
    case "subtask-add": {
      const { subtasks } = task;
      if (!subtasks.some((entry) => entry.id === change.subtaskId))
        subtasks.push({ id: change.subtaskId, title: change.title, completed: false });
      return;
    }
    case "subtask-move": {
      const from = task.subtasks.findIndex((child) => child.id === change.subtaskId);
      const to = from + change.direction;
      if (from < 0 || !task.subtasks[to]) return;
      const [child] = task.subtasks.splice(from, 1);
      task.subtasks.splice(to, 0, child!);
      return;
    }
    case "subtask-update":
    case "subtask-delete": {
      const subtask = task.subtasks.find((item) => item.id === change.subtaskId);
      if (!subtask) throw new Error("Sous-tâche indisponible");
      if (change.operation === "subtask-delete") {
        task.subtasks = task.subtasks.filter((item) => item !== subtask);
      } else {
        if (change.title !== undefined) subtask.title = change.title;
        if (change.completed !== undefined) subtask.completed = change.completed;
      }
      return;
    }
  }
}

function nextOrder(tasks: ProjectTask[]) {
  return tasks.reduce((max, task) => Math.max(max, task.order), -1) + 1;
}

function addTask(list: ProjectTodoList, change: Extract<Change, { operation: "add" }>) {
  if (list.tasks.some((item) => item.id === change.taskId)) return;
  if (!change.title && !change.description?.trim()) throw new Error("Tâche vide");
  const phase = list.phases.find((entry) => entry.id === change.phaseId);
  if (change.phaseId && !phase) throw new Error("Phase indisponible");
  const after = list.tasks.find((task) => task.id === change.afterTaskId);
  const afterPhase = list.phases.find((entry) => entry.name === after?.stage) ?? list.phases[0];
  const index = after && afterPhase === phase ? list.tasks.indexOf(after) + 1 : list.tasks.length;
  list.tasks.splice(index, 0, {
    id: change.taskId,
    title: change.title,
    stage: phase?.name ?? null,
    description: change.description ?? null,
    completed: false,
    order: nextOrder(list.tasks),
    subtasks: [],
  });
  if (index < list.tasks.length - 1)
    list.tasks.forEach((task, order) => {
      task.order = order;
    });
}

function duplicateTask(list: ProjectTodoList, id: string, copyId: string) {
  if (list.tasks.some((task) => task.id === copyId)) return;
  const task = requireTask(list.tasks, id);
  const phaseId = list.phases.find((phase) => phase.name === task.stage)?.id ?? list.phases[0]?.id;
  addTask(list, {
    operation: "add",
    taskId: copyId,
    phaseId,
    afterTaskId: id,
    title: task.title.slice(0, 992) + " (copie)",
    description: task.description,
  });
  const copy = requireTask(list.tasks, copyId);
  copy.subtasks = task.subtasks.map((child) => ({
    id: globalThis.crypto.randomUUID(),
    completed: false,
    title: child.title,
  }));
}

function updateTask(task: ProjectTask, change: Extract<Change, { operation: "update" }>) {
  if (change.title !== undefined) task.title = change.title;
  if (change.description !== undefined) task.description = change.description;
  if (change.status !== undefined) {
    task.status = change.status;
    task.completed = change.status === "done";
  } else if (change.completed !== undefined) {
    task.completed = change.completed;
    if (task.status !== undefined) task.status = change.completed ? "done" : "todo";
  }
}

type DispatchChange = Extract<Change, { operation: `queue-${string}` | `batch-${string}` }>;

function applyDispatchChange(list: ProjectTodoList, change: DispatchChange) {
  switch (change.operation) {
    case "queue-import": {
      const dispatch = getDispatch(list);
      if (dispatch.legacyImported) return;
      for (const taskId of change.taskIds) enqueue(list, taskId);
      dispatch.legacyImported = true;
      return;
    }
    case "queue-task": {
      const dispatch = getDispatch(list);
      if (change.queued) enqueue(list, change.taskId);
      else if (!dispatch.batches.some((batch) => batch.taskIds.includes(change.taskId))) {
        dispatch.queue = dispatch.queue.filter((id) => id !== change.taskId);
      }
      return;
    }
    case "batch-reserve":
      return reserveBatch(list, change);
    case "batch-observe":
      return observeBatch(list, change);
    case "batch-requeue": {
      const dispatch = getDispatch(list);
      const batch = dispatch.batches.find((entry) => entry.id === change.batchId);
      if (batch?.state !== "failed") return;
      dispatch.batches = dispatch.batches.filter((entry) => entry !== batch);
      for (const taskId of batch.taskIds) enqueue(list, taskId);
      return;
    }
  }
}

function reserveBatch(
  list: ProjectTodoList,
  change: Extract<DispatchChange, { operation: "batch-reserve" }>,
) {
  const dispatch = getDispatch(list);
  if (dispatch.batches.some((batch) => batch.id === change.batchId)) return;
  const reserved = new Set(dispatch.batches.flatMap((batch) => batch.taskIds));
  const taskIds = new Set(change.taskIds);
  const tasks = dispatch.queue
    .filter((id) => taskIds.has(id))
    .map((id) => requireTask(list.tasks, id));
  if (
    tasks.length !== taskIds.size ||
    tasks.some((task) => task.completed || reserved.has(task.id))
  ) {
    throw new Error("La sélection a changé");
  }
  dispatch.batches.push({
    id: change.batchId,
    taskIds: tasks.map((task) => task.id),
    destination: change.destination,
    title: "Prochaines actions · " + change.projectName,
    prompt: agentPrompt(change.projectName, tasks),
    state: "launching",
  });
}

function observeBatch(
  list: ProjectTodoList,
  change: Extract<DispatchChange, { operation: "batch-observe" }>,
) {
  const dispatch = list.dispatch;
  if (!dispatch) return;
  const batch = dispatch.batches.find((entry) => entry.id === change.batchId);
  if (!batch || batch.state === "review" || batch.state === "failed") return;
  if (batch.turnId && change.turnId !== batch.turnId) return;
  if (batch.state === "launching" && change.state === "unknown") return;
  batch.turnId ??= change.turnId;
  batch.state = change.state;
  dispatch.queue = dispatch.queue.filter((id) => !batch.taskIds.includes(id));
}

function applyChange(list: ProjectTodoList, change: Change) {
  if (
    "batchId" in change ||
    change.operation === "queue-import" ||
    change.operation === "queue-task"
  ) {
    return applyDispatchChange(list, change);
  }
  switch (change.operation) {
    case "reorder":
      return reorder(list, change.ids);
    case "phase-reorder":
      return reorderPhases(list, change.phaseId, change.overPhaseId);
    case "phase-add":
    case "phase-rename":
    case "phase-status":
    case "phase-delete":
    case "phase-move":
      return writePhase(list, change);
    case "add":
      return addTask(list, change);
    case "duplicate":
      return duplicateTask(list, change.taskId, change.copyId);
    case "delete": {
      const task = requireTask(list.tasks, change.taskId);
      list.tasks = list.tasks.filter((entry) => entry !== task);
      return;
    }
    case "update":
      return updateTask(requireTask(list.tasks, change.taskId), change);
    case "subtask-add":
    case "subtask-move":
    case "subtask-update":
    case "subtask-delete":
      return writeSubtask(requireTask(list.tasks, change.taskId), change);
  }
}

function getDispatch(list: ProjectTodoList): NonNullable<ProjectTodoList["dispatch"]> {
  return (list.dispatch ??= { queue: [], batches: [] });
}

function enqueue(list: ProjectTodoList, taskId: string) {
  const dispatch = getDispatch(list);
  if (
    !dispatch.queue.includes(taskId) &&
    !dispatch.batches.some((batch) => batch.taskIds.includes(taskId)) &&
    list.tasks.some((task) => task.id === taskId && !task.completed)
  ) {
    dispatch.queue.push(taskId);
  }
}

function pruneDispatch(list: ProjectTodoList) {
  const { dispatch } = list;
  if (!dispatch) return;
  const open = new Set(list.tasks.filter((task) => !task.completed).map((task) => task.id));
  dispatch.queue = dispatch.queue.filter((id) => open.has(id));
  dispatch.batches = dispatch.batches.filter((batch) => {
    if (batch.state === "launching" || batch.state === "running") return true;
    batch.taskIds = batch.taskIds.filter((id) => open.has(id));
    return batch.taskIds.length > 0;
  });
}

export function openProjectTodoStore(filename: string) {
  mkdirSync(path.dirname(filename), { recursive: true });
  closeSync(openSync(filename, "a", 0o600));
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS project_todos (
      project_key TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const select = db.prepare("SELECT data FROM project_todos WHERE project_key = ?");
  const selectBatch = db.prepare(`
    SELECT project_key FROM project_todos, json_each(data, '$.dispatch.batches') AS batch
    WHERE json_extract(batch.value, '$.id') = ?
    LIMIT 1
  `);
  const insert = db.prepare("INSERT INTO project_todos (project_key, data) VALUES (?, ?)");
  const store = db.prepare(`
    INSERT INTO project_todos (project_key, data) VALUES (?, ?)
    ON CONFLICT (project_key) DO UPDATE SET data = excluded.data
  `);

  function read(projectKey: string): ProjectTodoList {
    const data = select.get(projectKey)?.data;
    return typeof data === "string" ? projectTodoList.parse(JSON.parse(data)) : emptyList();
  }

  function write(projectKey: string, change: Change) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const list = read(projectKey);
      applyChange(list, change);
      pruneDispatch(list);
      store.run(projectKey, JSON.stringify(list));
      db.exec("COMMIT");
      return list;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function importProject(projectKey: string, value: unknown) {
    insert.run(projectKey, JSON.stringify(projectTodoList.parse(value)));
  }

  function observeAgent(batchId: string, state: BatchObservation, turnId?: string) {
    const projectKey = selectBatch.get(batchId)?.project_key;
    if (typeof projectKey === "string") {
      write(projectKey, { operation: "batch-observe", batchId, state, turnId });
    }
  }

  return { read, write, observeAgent, importProject, close: () => db.close() };
}
