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
  interval.extend({ action: z.literal("remove"), block: reference }),
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
export const coachReply = z.object({
  message: text,
  changes: z.array(change).max(12).optional(),
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
  lines: z.array(z.object({ id, kind: z.enum(["you", "answer"]), text: z.string() })),
  draft: draft.optional(),
  reflections: z.array(reflection.extend({ date: z.iso.date() })),
  season: season.optional(),
  pending: z.object({ id: z.uuid(), text, timeZone: z.string() }).optional(),
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
export const coachAction = defineRpc({
  name: "coach.action",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("read") }),
    z.object({ action: z.literal("send"), revision, text, skill: skill.optional(), timeZone }),
    z.object({ action: z.literal("retry"), revision }),
    z.object({ action: z.enum(["confirm", "reject"]), revision, id: z.uuid() }),
  ]),
  output: coachState
    .pick({ revision: true, skill: true, lines: true, draft: true, error: true })
    .extend({ busy: z.boolean(), canRetry: z.boolean() }),
});
export type CoachView = z.infer<typeof coachAction.output>;
