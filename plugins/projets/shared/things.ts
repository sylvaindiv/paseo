import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Order belongs to the application displaying the board.
const entity = z.object({
  id: z.string().regex(/^(p:|t:).+/),
  kind: z.enum(["project", "phase", "task", "child"]),
  parent: z
    .string()
    .regex(/^(p:|t:).+/)
    .nullable(),
  title: z.string(),
  notes: z.string().optional(),
  done: z.boolean().optional(),
});
export type Entity = z.infer<typeof entity>;
export type Rows = Record<string, Entity>;
export const fields = ["parent", "title", "notes", "done"] as const;
export type Field = (typeof fields)[number];
const patch = z.object({ before: entity.nullable(), after: entity.nullable() });
export type Patch = z.infer<typeof patch>;
const conflictSchema = z.object({
  id: z.string(),
  field: z.string(),
  paseo: z.string(),
  things: z.string(),
});
export type Conflict = z.infer<typeof conflictSchema>;
const snapshot = z.object({
  revision: z.string(),
  rows: z.array(entity),
  message: z.string(),
  conflicts: z.array(conflictSchema),
  enabled: z.boolean(),
  detached: z.array(z.object({ id: z.string(), title: z.string() })),
});
export const exchangeThings = defineRpc({
  name: "things.exchange",
  input: z.object({ edits: z.array(patch) }),
  output: snapshot,
});
export const waitThings = defineRpc({
  name: "things.wait",
  input: z.object({ revision: z.string() }),
  output: z.string(),
});
export const relinkThings = defineRpc({
  name: "things.relink",
  input: z.object({ id: z.string() }),
  output: z.boolean(),
});
export const chooseThings = defineRpc({
  name: "things.choose",
  input: z.object({
    revision: z.string(),
    id: z.string(),
    field: z.string(),
    choice: z.enum(["paseo", "things"]),
  }),
  output: z.boolean(),
});

export function same(a: Entity | null, b: Entity | null) {
  return (
    a === b ||
    Boolean(a && b && a.kind === b.kind && a.id === b.id && fields.every((f) => a[f] === b[f]))
  );
}
export function diffRows(before: Rows, after: Rows): Patch[] {
  const result: Patch[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[id] ?? null,
      b = after[id] ?? null;
    if (!same(a, b)) result.push({ before: a, after: b });
  }
  return result;
}

// Unrelated fields merge independently, including while a conflict is awaiting a choice.
export function applyPatch(
  current: Entity | null,
  { before, after }: Patch,
  conflict: (field: string) => void,
): Entity | null {
  if (same(current, after) || same(before, after)) return current;
  if (same(current, before)) return after;
  if (!before || !after || !current || before.kind !== after.kind || current.kind !== after.kind) {
    conflict("item");
    return current;
  }
  const result = { ...current };
  for (const field of fields) {
    if (before[field] === after[field] || after[field] === current[field]) continue;
    if (before[field] !== current[field]) conflict(field);
    else Object.assign(result, { [field]: after[field] });
  }
  return result;
}
