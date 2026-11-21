import type { ProjectTask } from "./project-todos.js";

export function agentPrompt(project: string, tasks: ProjectTask[]): string {
  const lines = tasks.flatMap((task, index) => [
    `${index + 1}. ${task.title}`,
    ...(task.description ? ["   " + task.description.replaceAll("\n", "\n   ")] : []),
    ...task.subtasks.map((child) => `   - [${child.completed ? "x" : " "}] ${child.title}`),
  ]);
  return [`Avance les tâches suivantes du projet « ${project} ».`, "", ...lines].join("\n");
}
