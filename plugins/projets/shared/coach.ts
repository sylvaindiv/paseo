import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const coachSkills = {
  day: "Planifier ma journée",
  reflection: "Bilan du jour",
  week: "Revue hebdomadaire",
  season: "Saison et objectifs",
} as const;
export const skill = z.enum(["day", "reflection", "week", "season"]);
export type CoachSkill = z.infer<typeof skill>;

const id = z.string().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
const interval = z.object({ start: instant, end: instant });
const range = z.object({ from: z.iso.date(), to: z.iso.date(), timeZone: z.string() });
const reference = z.object({ id, version: id });
const event = interval.extend({ id, title: z.string(), busy: z.boolean() });
export const calendar = z.object({
  access: z.enum(["ready", "unavailable", "denied"]),
  events: z.array(event),
  blocks: z.array(interval.extend({ id, version: id, title: z.string(), taskId: id })),
});
export const change = z.discriminatedUnion("action", [
  interval.extend({ action: z.literal("create"), taskId: id }),
  interval.extend({ action: z.literal("move"), blockId: id }),
  z.object({ action: z.literal("remove"), blockId: id }),
]);
const writeChange = z.discriminatedUnion("action", [
  interval.extend({ action: z.literal("create"), task: reference }),
  interval.extend({ action: z.literal("move"), block: reference }),
  interval.partial().extend({ action: z.literal("remove"), block: reference }),
]);
const planningResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied") }),
  z.object({ status: z.literal("conflict") }),
  z.object({ status: z.literal("denied") }),
]);
export type PlanningResult = z.infer<typeof planningResult>;
export type CalendarSnapshot = z.infer<typeof calendar>;
export type CoachRange = z.infer<typeof range>;

const text = z.string().trim().min(1).max(3500);
export const coachMessageLimit = 100_000;
const userMessage = z.string().trim().min(1).max(coachMessageLimit);
export const taskEdit = z.object({
  title: text,
  subtasks: z.array(text).max(30),
  criteria: z.string().trim().max(3500),
  today: z.boolean(),
});
const taskProposal = z.object({
  project: reference,
  existing: reference.optional(),
  edit: taskEdit,
});
export type CoachTaskProposal = z.infer<typeof taskProposal>;
const taskDraft = z.object({
  kind: z.literal("task"),
  id: z.uuid(),
  summary: z.string(),
  proposal: taskProposal,
  applying: z.boolean().optional(),
});
const projectCoachTitle = z.string().trim().min(1).max(240);
const projectCoachTask = z.object({
  title: projectCoachTitle,
  subtasks: z.array(projectCoachTitle).max(15),
  criteria: z.string().trim().max(1500),
});

export const coachProject = defineRpc({
  name: "coach.project",
  input: z.object({
    threadId: z.uuid(),
    turnId: z.uuid(),
    action: z.enum(["start", "discuss", "phases", "tasks"]),
    project: z.object({
      title: z.string().max(1000),
      notes: z.string().max(6000),
      existingTasks: z.array(z.string().max(240)).max(40),
    }),
    objective: z.string().trim().max(1500),
    phases: z.array(projectCoachTitle).max(15),
    phase: projectCoachTitle.optional(),
    text: z.string().max(12_000).optional(),
    documents: z
      .array(
        z.object({
          path: z.string().max(500),
          excerpt: z.string().max(4000),
        }),
      )
      .max(6),
  }),
  output: z.object({
    message: text,
    objective: z.string().trim().min(1).max(1500).optional(),
    phases: z.array(projectCoachTitle).min(1).max(15).optional(),
    tasks: z.array(projectCoachTask).min(1).max(15).optional(),
  }),
});

const reflection = z.object({
  done: text,
  obstacles: text,
  energy: text,
  taskIds: z.array(id).max(30),
  projectIds: z.array(id).max(20),
});
const season = z.object({
  from: z.iso.date(),
  through: z.iso.date(),
  goal: text,
  priorities: z
    .array(
      z.object({
        projectId: id,
        level: z.enum(["main", "secondary", "maintain"]),
        outcome: text,
      }),
    )
    .min(1)
    .max(20),
});
export const coachMemoryLimit = 16_000;
const memoryText = z.string().max(coachMemoryLimit);
const memory = z.object({ text: memoryText, revision: z.number().int().nonnegative() });
export const coachMemory = defineRpc({
  name: "coach.memory",
  input: z.object({ text: memoryText.optional() }),
  output: memory,
});

const energyValue = z.enum(["more", "same", "less"]);
export const energyEntry = z.object({
  id,
  title: z.string(),
  date: z.iso.datetime(),
  value: energyValue.optional(),
});
export const coachEnergy = defineRpc({
  name: "coach.energy",
  input: z.object({ entry: energyEntry.optional() }),
  output: z.array(energyEntry),
});

export const weekAdjustment = z.object({
  week: z.iso.date(),
  text,
  decision: z.enum(["try", "pass"]).optional(),
  helpful: z.boolean().optional(),
});
export const coachReview = defineRpc({
  name: "coach.review",
  input: z.union([
    z.object({ week: z.iso.date(), decision: z.enum(["try", "pass"]) }),
    z.object({ week: z.iso.date(), helpful: z.boolean() }),
  ]),
  output: z.boolean(),
});

export const coachReply = z.object({
  memoryUpdate: memoryText.optional(),
  adjustment: text.optional(),
  suggestedSlot: interval.optional(),
  message: text,
  changes: z.array(change).max(12).optional(),
  tasks: z
    .array(
      z.object({
        projectId: id,
        taskId: id.optional(),
        edit: taskEdit,
      }),
    )
    .max(5)
    .optional(),
  reflection: reflection.optional(),
  season: season.optional(),
});
const plan = range.extend({
  kind: z.literal("plan"),
  id: z.uuid(),
  changes: z.array(writeChange).min(1),
  summary: z.string(),
  applying: z.boolean().optional(),
});
const draft = z.discriminatedUnion("kind", [
  plan,
  taskDraft,
  reflection.extend({
    kind: z.literal("reflection"),
    id: z.uuid(),
    date: z.iso.date(),
    summary: z.string(),
  }),
  season.extend({ kind: z.literal("season"), id: z.uuid(), summary: z.string() }),
]);
export type CoachPlan = z.infer<typeof plan>;
export const coachState = z.object({
  threadId: z.uuid(),
  revision: z.number(),
  skill,
  lines: z.array(
    z.object({
      id,
      kind: z.enum(["you", "answer"]),
      text: z.string(),
      date: z.iso.datetime().optional(),
    }),
  ),
  draft: draft.optional(),
  taskQueue: z.array(taskDraft).optional(),
  proposals: z.array(z.object({ date: z.iso.datetime(), draft })).optional(),
  reflections: z.array(reflection.extend({ date: z.iso.date() })),
  season: season.optional(),
  pending: z
    .object({ id: z.uuid(), text: userMessage, timeZone: z.string(), projectId: id.optional() })
    .optional(),
  error: z.string().optional(),
});
export type CoachState = z.infer<typeof coachState>;

const revision = z.number().int().nonnegative();
const timeZone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      return Boolean(new Intl.DateTimeFormat("fr", { timeZone: value }));
    } catch {
      return false;
    }
  });
const threadSummaries = z.array(z.object({ threadId: z.uuid(), skill }));

export const coachList = defineRpc({
  name: "coach.list",
  input: z.object({}),
  output: threadSummaries,
});

export const coachAction = defineRpc({
  name: "coach.action",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("read"), threadId: z.uuid().optional() }),
    z.object({ action: z.literal("start"), threadId: z.uuid(), skill, timeZone }),
    z.object({
      action: z.literal("send"),
      threadId: z.uuid(),
      revision,
      text: userMessage,
      timeZone,
      projectId: id.optional(),
    }),
    z.object({ action: z.literal("retry"), threadId: z.uuid(), revision }),
    z.object({
      action: z.enum(["confirm", "reject"]),
      threadId: z.uuid(),
      revision,
      id: z.uuid(),
      edit: taskEdit.optional(),
    }),
  ]),
  output: coachState
    .pick({ threadId: true, revision: true, skill: true, lines: true, draft: true, error: true })
    .extend({
      busy: z.boolean(),
      adjustment: weekAdjustment.optional(),
      followUp: weekAdjustment.optional(),
      preview: z.string().optional(),
      canRetry: z.boolean(),
      threads: threadSummaries,
    }),
});
export type CoachView = z.infer<typeof coachAction.output>;
