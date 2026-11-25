import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  CalendarSnapshot,
  CoachPlan,
  CoachRange,
  PlanningResult,
  coachReply,
} from "../shared/coach.js";
import type { SequenceRow } from "../shared/sequence.js";

const exec = promisify(execFile);
const instant = z.iso.datetime({ offset: true });
const slotSchema = z.object({ start: instant, end: instant });
const item = z.object({ id: z.string(), title: z.string(), slot: slotSchema });
const response = z.object({
  planning: z
    .object({
      calendarAccess: z.enum(["authorized", "unknown"]),
      events: z.array(item.extend({ busy: z.boolean() })),
      blocks: z.array(item.extend({ version: z.string(), taskID: z.string() })),
    })
    .optional(),
  receipt: z.object({ requestID: z.uuid() }).optional(),
  conflict: z.object({ reason: z.string() }).optional(),
  error: z.string().optional(),
});

async function request(input: object) {
  const source = process.env.PASEO_THINGS_SOURCE ?? join(homedir(), "Applis/Perso/Things");
  const app =
    process.env.PASEO_THINGS_PLANNING_APP ??
    join(homedir(), "Library/Application Support/Things Local/Planning Things Local.app");
  const run = exec(join(source, "Tools/paseo-planning"), [app], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  run.child.stdin?.on("error", () => {});
  run.child.stdin?.end(JSON.stringify(input));
  return response.parse(JSON.parse((await run).stdout));
}

export const thingsPlanning = {
  async read(range: CoachRange): Promise<CalendarSnapshot> {
    try {
      const { timeZone } = range;
      const { planning } = await request({
        action: "planning.read",
        timeZone,
        period: { start: midnight(range.from, timeZone), end: midnight(range.to, timeZone) },
      });
      if (planning)
        return {
          access: planning.calendarAccess === "authorized" ? "ready" : "denied",
          events: planning.events.map(({ id, title, slot, busy }) => ({
            id,
            title,
            busy,
            start: slot.start,
            end: slot.end,
          })),
          blocks: planning.blocks.map(({ id, title, version, taskID, slot }) => ({
            id,
            title,
            version,
            taskId: taskID,
            start: slot.start,
            end: slot.end,
          })),
        };
    } catch {
      // A missing tool or unavailable calendar leaves task prioritization usable.
    }
    return { access: "unavailable", events: [], blocks: [] };
  },
  async apply({ id, timeZone, changes }: CoachPlan): Promise<PlanningResult> {
    const result = await request({
      action: "planning.apply",
      timeZone,
      requestID: id,
      changes: changes.map(({ action, start, end, ...entry }) => ({
        kind: action,
        slot: {
          start: new Date(start).toISOString().replace(".000Z", "Z"),
          end: new Date(end).toISOString().replace(".000Z", "Z"),
        },
        ...("task" in entry
          ? { taskID: entry.task.id }
          : { id: entry.block.id, version: entry.block.version }),
      })),
    });
    if (result.receipt?.requestID.toLowerCase() === id.toLowerCase()) return { status: "applied" };
    if (result.conflict)
      return { status: result.conflict.reason === "calendarUnknown" ? "denied" : "conflict" };
    throw new Error(result.error ?? "Confirmation de Things indisponible.");
  },
};

function midnight(day: string, timeZone: string) {
  const utc = Date.parse(day) / 1000;
  let lower = utc - 36 * 3600;
  let upper = utc + 36 * 3600;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (dateIn(middle * 1000, timeZone) < day) lower = middle + 1;
    else upper = middle;
  }
  return new Date(upper * 1000).toISOString().replace(".000Z", "Z");
}

export function dateIn(date: number | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("fr", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key)?.value)
    .join("-");
}

export function offsetDay(day: string, offset: number) {
  return new Date(Date.parse(day) + offset * 86_400_000).toISOString().slice(0, 10);
}

export function formatInterval(start: string, end: string, timeZone: string) {
  const date = new Intl.DateTimeFormat("fr", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(Date.parse(start));
  const clock = new Intl.DateTimeFormat("fr", { timeZone, hour: "2-digit", minute: "2-digit" });
  return `${date}, ${clock.format(Date.parse(start))}–${clock.format(Date.parse(end))} (${(Date.parse(end) - Date.parse(start)) / 60_000} min)`;
}

type Change = NonNullable<z.infer<typeof coachReply>["changes"]>[number];

export function preparePlan(
  proposal: Change[],
  range: CoachRange,
  snapshot: CalendarSnapshot,
  tasks: SequenceRow[],
  now: number,
): Pick<CoachPlan, "changes" | "summary"> {
  const affected = proposal.flatMap((entry) => (entry.action === "create" ? [] : [entry.blockId]));
  const occupied = [
    ...snapshot.events.filter((event) => event.busy),
    ...snapshot.blocks.filter((block) => !affected.includes(block.id)),
  ];
  if (snapshot.access !== "ready" || new Set(affected).size !== affected.length)
    throw new Error("Vérifie les créneaux proposés.");

  const labels: string[] = [];
  const changes = proposal.map((entry): CoachPlan["changes"][number] => {
    const block =
      entry.action === "create"
        ? undefined
        : snapshot.blocks.find((row) => row.id === entry.blockId);
    if (entry.action === "remove") {
      if (!block || Date.parse(block.start) < now) throw new Error("Ce bloc a changé.");
      labels.push(
        `Retirer · ${block.title} · ${formatInterval(block.start, block.end, range.timeZone)}`,
      );
      return {
        action: "remove",
        block: { id: block.id, version: block.version },
        start: block.start,
        end: block.end,
      };
    }
    const { start, end } = entry;
    const a = Date.parse(start);
    const b = Date.parse(end);
    if (
      a < now ||
      a % 1000 !== 0 ||
      b % 1000 !== 0 ||
      b <= a ||
      dateIn(a, range.timeZone) < range.from ||
      dateIn(b - 1, range.timeZone) >= range.to ||
      occupied.some((other) => Date.parse(other.start) < b && a < Date.parse(other.end))
    )
      throw new Error("Ce créneau est indisponible.");
    occupied.push({ id: "", title: "", busy: true, start, end });
    const interval = formatInterval(start, end, range.timeZone);
    if (entry.action === "move") {
      if (!block || Date.parse(block.start) < now) throw new Error("Ce bloc a changé.");
      labels.push(
        `Déplacer · ${block.title} · ${formatInterval(block.start, block.end, range.timeZone)} → ${interval}`,
      );
      return { action: "move", block: { id: block.id, version: block.version }, start, end };
    }
    const task = tasks.find((row) => row.id === entry.taskId);
    if (!task || !task.eligible || task.status === "done") throw new Error("Cette tâche a changé.");
    labels.push(`${task.title} · ${interval}`);
    return { action: "create", task: { id: task.id, version: task.version }, start, end };
  });
  return { changes, summary: labels.join("\n") };
}
