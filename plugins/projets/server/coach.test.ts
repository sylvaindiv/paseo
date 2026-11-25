import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { expect, test, vi } from "vitest";
import { coachAction } from "../shared/coach.js";
import { coachHandler } from "./coach.js";
import { thingsPlanning } from "./coach-planning.js";

test("a revised draft needs explicit confirmation and a conflict needs a new decision", async () => {
  const home = await mkdtemp(join(tmpdir(), "projets-coach-"));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-07T09:00:00Z"));
  const timeZone = "UTC";
  const library = join(home, "Library.sqlite");
  vi.stubEnv("PERSO_THINGS_DATABASE", library);
  const db = new DatabaseSync(library);
  db.exec("CREATE TABLE items (body BLOB NOT NULL)");
  db.prepare("INSERT INTO items VALUES (?)").run(
    Buffer.from(
      JSON.stringify({
        id: "finished",
        title: "Préparer le brief",
        kind: "task",
        canceled: false,
        trashed: false,
        completedAt: (Date.parse("2030-01-04T08:00:00Z") - Date.UTC(2001, 0, 1)) / 1000,
      }),
    ),
  );
  db.close();
  const task = {
    id: "brief",
    title: "Relire le brief",
    version: "v1",
    kind: "task" as const,
    today: true,
    eligible: true,
    someday: false,
    notes: "",
    checklist: [],
    images: [],
  };
  const sequence = async () => ({
    sequence: {
      day: 20300107,
      projects: [{ ...task, id: "client", title: "Client", kind: "project" as const }],
      rows: [task],
    },
  });
  let moved = false;
  let access: "ready" | "denied" = "ready";
  let lostReceipt = false;
  const receipts = new Set<string>();
  const read = vi.fn(async () => ({
    access,
    events: [
      {
        id: "meeting",
        busy: true,
        title: "Rendez-vous",
        start: moved ? "2030-01-07T09:00:00Z" : "2030-01-07T09:45:00Z",
        end: "2030-01-07T10:00:00Z",
      },
    ],
    blocks: [],
  }));
  const apply = vi.fn<Parameters<typeof coachHandler>[3]["apply"]>(async (plan) => {
    if (
      moved &&
      plan.changes.some(
        (entry) => entry.action === "create" && entry.start < "2030-01-07T10:00:00Z",
      )
    )
      return { status: "conflict" };
    if (!receipts.has(plan.id)) {
      receipts.add(plan.id);
      if (!lostReceipt) {
        lostReceipt = true;
        throw new Error("Réponse interrompue");
      }
    }
    return { status: "applied" };
  });
  const run = vi.fn<Parameters<typeof coachHandler>[2]>(async (_id, _context, prompt) => {
    if (prompt.includes('"message":"Bilan du jour"'))
      return JSON.stringify({
        message: "Ton bilan",
        reflection: {
          done: "Brief relu",
          obstacles: "Interruptions",
          energy: "Bonne",
          taskIds: ["brief"],
          projectIds: [],
        },
      });
    if (prompt.includes('"message":"Revue hebdomadaire"')) {
      expect(prompt).toContain('"date":"2030-01-07"');
      expect(prompt).toContain('"done":"Brief relu"');
      expect(prompt).toContain('"title":"Préparer le brief","date":"2030-01-04"');
      expect(prompt).toContain("distingue prévu, terminé dans Things et réalisé déclaré");
      return JSON.stringify({ message: "Le 7 janvier, tu as déclaré avoir relu le brief." });
    }
    if (prompt.includes('"message":"Saison et objectifs"')) {
      return JSON.stringify({
        message: "Voici ta saison",
        season: {
          from: "2030-01-07",
          through: "2030-03-31",
          goal: "Livrer le dossier",
          priorities: [{ projectId: "client", level: "main", outcome: "Dossier prêt" }],
        },
      });
    }
    if (prompt.includes('"access":"denied"')) {
      expect(prompt).toContain('"outcome":"Dossier prêt"');
      return JSON.stringify({ message: "Relis le brief en 30 minutes." });
    }
    const start = moved ? "10:00" : "09:00";
    const initialEnd = prompt.includes('"message":"30 minutes"') ? "09:30" : "09:45";
    const end = moved ? "10:30" : initialEnd;
    return JSON.stringify({
      message: "Tu peux relire le brief.",
      changes: [
        {
          action: "create",
          taskId: "brief",
          start: `2030-01-07T${start}:00Z`,
          end: `2030-01-07T${end}:00Z`,
        },
      ],
    });
  });
  type Input = Parameters<typeof coachAction.input.parse>[0];
  let invoke: (input: Input) => Promise<ReturnType<typeof coachAction.output.parse>> = async () => {
    throw new Error("Coach RPC was not registered");
  };
  const context = {} as PluginHandlerContext;
  const server = {
    handle(
      _rpc: typeof coachAction,
      handler: (
        input: ReturnType<typeof coachAction.input.parse>,
        context: PluginHandlerContext,
      ) => Promise<unknown>,
    ) {
      invoke = async (input) =>
        coachAction.output.parse(await handler(coachAction.input.parse(input), context));
    },
  } as PluginServerContext;
  let stop = coachHandler(server, sequence, run, { read, apply }, home);
  try {
    let state = await invoke({ action: "read" });
    const send = (text: string, skill?: "day" | "reflection" | "week" | "season") =>
      invoke({ action: "send", revision: state.revision, timeZone, text, skill });
    const decision = (action: "confirm" | "reject") =>
      invoke({ action, revision: state.revision, id: state.draft?.id });
    state = await send("J’ai 45 minutes avant mon rendez-vous, que puis-je avancer ?");
    expect(state.draft?.summary).toContain("09:00–09:45 (45 min)");
    const stale = { action: "confirm", revision: state.revision, id: state.draft?.id };
    state = await send("30 minutes");
    expect(state.draft?.summary).toContain("09:00–09:30 (30 min)");
    await invoke(stale);
    state = await decision("reject");
    expect(state.draft).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();

    state = await send("30 minutes");
    moved = true;
    const oldId = state.draft?.id;
    state = await decision("confirm");
    expect(receipts.size).toBe(0);
    expect(state.draft?.id).not.toBe(oldId);
    expect(state.draft?.summary).toContain("10:00–10:30 (30 min)");
    const newId = state.draft?.id;
    state = await decision("confirm");
    expect(state.error).toContain("Réessaie");
    expect(receipts.size).toBe(1);
    await stop();
    stop = coachHandler(server, sequence, run, { read, apply }, home);
    state = await invoke({ action: "read" });
    expect(state.draft?.id).toBe(newId);
    const confirmed = { action: "confirm", revision: state.revision, id: newId };
    state = await decision("confirm");
    expect(state.draft).toBeUndefined();
    expect((await invoke(confirmed)).lines.at(-1)?.text).toBe("Planning enregistré dans Things.");
    expect([...receipts]).toEqual([newId]);
    expect(apply.mock.calls.map(([draft]) => draft.id)).toEqual([oldId, newId, newId]);

    state = await send("Bilan du jour", "reflection");
    state = await decision("confirm");
    await stop();
    stop = coachHandler(server, sequence, run, { read, apply }, home);
    state = await invoke({ action: "read" });
    expect(state.lines.at(0)?.text).toContain("45 minutes");
    expect(state.lines.at(-1)?.text).toBe("Bilan enregistré.");
    state = await send("Revue hebdomadaire", "week");
    expect(state.lines.at(-1)?.text).toContain("tu as déclaré");
    state = await send("Saison et objectifs", "season");
    expect(state.draft?.summary).toContain("Principal · Client · Dossier prêt");
    state = await decision("confirm");
    access = "denied";
    state = await send("Planifier ma journée", "day");
    expect(state.lines.at(-1)?.text).toBe("Agenda indisponible.\nRelis le brief en 30 minutes.");
    expect(state.draft).toBeUndefined();
    expect(receipts.size).toBe(1);
  } finally {
    await stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

test("the Mac tool receives the date range and stable, versioned write request over stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "projets-planning-tool-"));
  const executable = join(directory, "Tools", "paseo-planning");
  await mkdir(join(directory, "Tools"));
  try {
    const id = randomUUID();
    const range = { from: "2030-01-07", to: "2030-01-08", timeZone: "Europe/Paris" };
    const changes = [
      {
        action: "move" as const,
        block: { id: "block-1", version: "v5" },
        start: "2030-01-07T11:00:00+01:00",
        end: "2030-01-07T11:30:00+01:00",
      },
    ];
    await writeFile(
      executable,
      `#!${process.execPath}
const { readFileSync } = require("node:fs");
const assert = require("node:assert/strict");
const input = JSON.parse(readFileSync(0, "utf8"));
const timeZone = "Europe/Paris";
if (input.action === "planning.read") {
  assert.deepEqual(input, { action: "planning.read", timeZone,
    period: { start: "2030-01-06T23:00:00Z", end: "2030-01-07T23:00:00Z" } });
  console.log(JSON.stringify({ planning: { calendarAccess: "authorized", events: [], blocks: [{
    id: "block-1", version: "v5", title: "Brief", taskID: "brief",
    slot: { start: "2030-01-07T09:00:00Z", end: "2030-01-07T09:30:00Z" },
  }] } }));
} else {
  assert.deepEqual(input, { action: "planning.apply", timeZone,
    requestID: ${JSON.stringify(id)}, changes: [{ kind: "move", id: "block-1", version: "v5",
      slot: { start: "2030-01-07T10:00:00Z", end: "2030-01-07T10:30:00Z" } }] });
  console.log(JSON.stringify({ conflict: { reason: "occupied" } }));
}
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PASEO_THINGS_SOURCE", directory);
    expect(await thingsPlanning.read(range)).toMatchObject({
      access: "ready",
      blocks: [{ id: "block-1", version: "v5", taskId: "brief" }],
    });
    expect(
      await thingsPlanning.apply({ kind: "plan", id, ...range, changes, summary: "Brief" }),
    ).toEqual({ status: "conflict" });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
