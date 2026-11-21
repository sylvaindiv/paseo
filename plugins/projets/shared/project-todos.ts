import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const id = z.string().min(1).max(100);
const title = z.string().trim().min(1).max(1000);
const subtask = z.object({ id, title, completed: z.boolean() });
export const phaseStatuses = [null, "À PLANNIFIER", "EN COURS", "EN ATTENTE", "OK"] as const;
const phaseStatus = z.literal(phaseStatuses);
export const projectPhase = z.looseObject({
  id,
  name: z.string(),
  order: z.number(),
  status: phaseStatus.optional(),
});
const taskStatus = z.enum(["todo", "doing", "done"]);
const notes = z.string().nullable();
export const projectTask = subtask.extend({
  title: z.string().max(1000),
  status: taskStatus.optional(),
  stage: z.string().nullable(),
  description: notes,
  order: z.number(),
  subtasks: z.array(subtask),
});

export const batchLabel = "projets.batch";
const taskIds = z.array(id);
export const batchDestination = z.object({
  serverId: z.string().min(1),
  workspaceId: id,
  providerModel: z.string().min(1),
});
const batchObservation = z.enum(["running", "review", "failed", "unknown"]);
const projectBatch = z.object({
  id,
  taskIds,
  destination: batchDestination,
  title: z.string().min(1),
  prompt: z.string(),
  state: z.enum(["launching", ...batchObservation.options]),
  turnId: z.string().min(1).optional(),
});

export const projectTodoList = z.object({
  phases: z.array(projectPhase).min(1),
  tasks: z.array(projectTask),
  dispatch: z
    .object({
      queue: taskIds,
      batches: z.array(projectBatch),
      legacyImported: z.boolean().optional(),
    })
    .optional(),
});

export type BatchObservation = z.infer<typeof batchObservation>;
export type BatchDestination = z.infer<typeof batchDestination>;
export type ProjectBatch = z.infer<typeof projectBatch>;
export type ProjectPhase = z.infer<typeof projectPhase>;
export type ProjectTask = z.infer<typeof projectTask>;
export type ProjectSubtask = z.infer<typeof subtask>;
export type ProjectTodoList = z.infer<typeof projectTodoList>;

export function groupProjectTasks(phases: readonly ProjectPhase[], tasks: readonly ProjectTask[]) {
  const grouped = new Map(phases.map((phase) => [phase.id, [] as ProjectTask[]]));
  for (const task of tasks) {
    const phase = phases.find((entry) => entry.name === task.stage) ?? phases[0];
    if (phase) grouped.get(phase.id)?.push(task);
  }
  return grouped;
}

export function currentProjectPhase<Phase extends Pick<ProjectPhase, "status">>(
  phases: readonly Phase[],
) {
  return (
    phases.find((phase) => phase.status === "EN COURS") ??
    phases.find((phase) => phase.status !== "OK") ??
    phases[0]
  );
}

const projectKey = z.string().min(1).max(4096);
export const readProjectTodos = defineRpc({
  name: "todos.get",
  input: z.object({ projectKey }),
  output: projectTodoList,
});

const overviewPhase = z.object({
  id,
  name: z.string(),
  status: phaseStatus,
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type OverviewPhase = z.infer<typeof overviewPhase>;

export const readProjectsOverview = defineRpc({
  name: "todos.overview.get",
  input: z.object({ projectKeys: z.array(projectKey) }),
  output: z.array(z.object({ projectKey, phases: z.array(overviewPhase) })),
});

const taskUpdate = z.object({
  operation: z.literal("update"),
  taskId: id,
  title: title.optional(),
  description: notes.optional(),
  status: taskStatus.optional(),
  completed: z.boolean().optional(),
});
const subtaskUpdate = z.object({
  operation: z.literal("subtask-update"),
  taskId: id,
  subtaskId: id,
  title: title.optional(),
  completed: z.boolean().optional(),
});
export const writeProjectTodo = defineRpc({
  name: "todos.write",
  input: z.object({
    projectKey,
    change: z.discriminatedUnion("operation", [
      z.object({
        operation: z.literal("add"),
        taskId: id,
        title: z.string().trim().max(1000),
        description: notes.optional(),
        phaseId: id.optional(),
        afterTaskId: id.optional(),
      }),
      z.object({ operation: z.literal("phase-add"), phaseId: id, title }),
      z.object({ operation: z.literal("phase-rename"), phaseId: id, title }),
      z.object({ operation: z.literal("phase-status"), phaseId: id, status: phaseStatus }),
      z.object({ operation: z.literal("phase-delete"), phaseId: id }),
      z.object({ operation: z.literal("phase-reorder"), phaseId: id, overPhaseId: id }),
      z.object({ operation: z.literal("phase-move"), phaseId: id, taskId: id }),
      taskUpdate,
      z.object({ operation: z.literal("duplicate"), taskId: id, copyId: id }),
      z.object({
        operation: z.literal("subtask-move"),
        taskId: id,
        subtaskId: id,
        direction: z.literal([-1, 1]),
      }),
      z.object({ operation: z.literal("delete"), taskId: id }),
      z.object({ operation: z.literal("reorder"), ids: z.array(id).min(2).max(1000) }),
      z.object({ operation: z.literal("subtask-add"), taskId: id, subtaskId: id, title }),
      subtaskUpdate,
      z.object({ operation: z.literal("subtask-delete"), taskId: id, subtaskId: id }),
      z.object({ operation: z.literal("queue-import"), taskIds }),
      z.object({ operation: z.literal("queue-task"), taskId: id, queued: z.boolean() }),
      z.object({
        operation: z.literal("batch-reserve"),
        batchId: id,
        taskIds: taskIds.min(1),
        projectName: title,
        destination: batchDestination,
      }),
      z.object({
        operation: z.literal("batch-observe"),
        batchId: id,
        state: batchObservation,
        turnId: z.string().min(1).optional(),
      }),
      z.object({ operation: z.literal("batch-requeue"), batchId: id }),
    ]),
  }),
  output: z.object({ ok: z.literal(true), batch: projectBatch.optional() }),
});
