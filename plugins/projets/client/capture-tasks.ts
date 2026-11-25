import type { Sequence, SequenceRequest } from "../shared/sequence.js";
import type { CaptureReply } from "../shared/task-capture.js";

type Commit = Extract<SequenceRequest, { action: "capture" }>;

export function captureContext(sequence: Sequence) {
  return sequence.projects.map((project, index) => {
    const rows = sequence.rows.filter((row) => row.parent === project.id);
    const phases = rows.filter((row) => row.kind === "heading");
    const tasks = rows.filter((row) => row.kind === "task");
    return {
      project: index,
      name: project.title,
      phases: phases.map((phase, id) => ({ id, name: phase.title })),
      tasks: tasks.map((task, id) => {
        const phase = phases.findIndex((row) => row.id === task.section);
        return {
          id,
          title: task.title,
          phase: phase < 0 ? null : phase,
          subtasks: task.checklist.map((child) => child.title),
        };
      }),
    };
  });
}

export function captureDrafts(
  sequence: Sequence,
  reply: CaptureReply,
  selected: number | null,
  allImages?: number[],
): NonNullable<Commit["tasks"]> {
  return reply.tasks.map((draft) => {
    const project = sequence.projects[draft.project];
    if (!project || (selected !== null && selected !== draft.project))
      throw new Error("Projet à préciser.");
    const rows = sequence.rows.filter((row) => row.parent === project.id);
    const section =
      draft.phase === null ? undefined : rows.filter((row) => row.kind === "heading")[draft.phase];
    const existing =
      draft.existing === null
        ? undefined
        : rows.filter((row) => row.kind === "task")[draft.existing];
    if ((draft.phase !== null && !section) || (draft.existing !== null && !existing))
      throw new Error("Vérifie la destination de « " + draft.title + " ».");
    return { ...draft, project, section, existing, images: allImages ?? draft.images };
  });
}
