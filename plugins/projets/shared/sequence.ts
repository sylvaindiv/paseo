import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { batchObservation, projectBatch } from "./project-todos.js";

const row = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  version: z.string(),
  status: z.enum(["todo", "inProgress", "waiting", "done"]).optional(),
  parent: z.string().optional(),
  section: z.string().optional(),
  kind: z.enum(["project", "heading", "task"]),
  today: z.boolean(),
  eligible: z.boolean(),
  someday: z.boolean(),
  deadline: z.number().optional(),
  checklist: z.array(z.object({ id: z.string(), title: z.string(), done: z.boolean() })),
  images: z.array(z.string()),
});
const sequence = z.object({ day: z.number(), projects: z.array(row), rows: z.array(row) });
export type Sequence = z.infer<typeof sequence>;
export type SequenceRow = z.infer<typeof row>;

const reference = row.pick({ id: true, version: true });
const draft = z.object({
  project: reference,
  section: reference.optional(),
  existing: reference.optional(),
  title: z.string().trim().min(1),
  note: z.string(),
  subtasks: z.array(z.string().trim().min(1)),
  images: z.array(z.number().int().nonnegative()),
});
export const sequenceAction = defineRpc({
  name: "sequence.action",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("read") }),
    z.object({ action: z.literal("move"), id: z.string(), target: z.string() }),
    z.object({
      action: z.literal("schedule"),
      id: z.string(),
      ids: z.array(z.string()).min(1),
      today: z.boolean(),
    }),
    z.object({ action: z.literal("image"), id: z.string() }),
    z.object({
      action: z.literal("capture"),
      id: z.uuid(),
      tasks: z.array(draft).min(1).optional(),
      images: z.array(z.string()).optional(),
    }),
  ]),
  output: z.object({
    sequence: sequence.optional(),
    receipt: z.object({ ids: z.array(z.string()), summary: z.string() }).optional(),
    image: z.string().optional(),
    error: z.string().optional(),
    stale: z.boolean().optional(),
  }),
});
export type SequenceRequest = z.input<typeof sequenceAction.input>;

export const sequenceAssociation = defineRpc({
  name: "sequence.association",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("read"), project: z.string().min(1) }),
    z.object({
      action: z.literal("write"),
      project: z.string().min(1),
      destination: z.string().min(1).nullable(),
    }),
  ]),
  output: z.string().nullable(),
});

const sequenceRun = projectBatch.extend({
  profile: z.object({
    id: z.string(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
  }),
  images: z.array(z.string()),
});
export type SequenceRun = z.infer<typeof sequenceRun>;
export const sequenceActivity = defineRpc({
  name: "sequence.activity",
  input: z.object({}),
  output: z.array(z.object({ task: z.string(), agentId: z.string(), serverId: z.string() })),
});
export const sequenceTracking = defineRpc({
  name: "sequence.tracking",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("read"), task: z.string() }),
    z.object({
      action: z.literal("reserve"),
      project: z.string().min(1),
      task: z.string(),
      run: sequenceRun,
      previous: z.string().optional(),
    }),
    z.object({
      action: z.literal("observe"),
      task: z.string(),
      id: z.string(),
      state: batchObservation,
      turnId: z.string().optional(),
    }),
  ]),
  output: sequenceRun.nullable(),
});
