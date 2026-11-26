import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { expect, test, vi } from "vitest";
import {
  coachAction,
  coachEnergy,
  coachList,
  coachMemory,
  coachReview,
  coachState,
  type CoachSkill,
} from "../shared/coach.js";
import { coachHandler, coachReplyPreview } from "./coach.js";
import { thingsPlanning } from "./coach-planning.js";

const draftId = (state: ReturnType<typeof coachState.parse>) => state.draft?.id;

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
    parent: "client",
    title: "Relire le brief",
    version: "v1",
    kind: "task" as const,
    today: true,
    eligible: true,
    someday: false,
    createdAt: "2029-12-17T09:00:00Z",
    notes: "Relire rapidement.",
    checklist: [{ id: "read", title: "Revoir la conclusion", done: false }],
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
  const taskReceipts = new Set<string>();
  const applyTask = vi.fn<NonNullable<Parameters<typeof coachHandler>[6]>>(async (id) => {
    if (!taskReceipts.has(id)) {
      taskReceipts.add(id);
      return { error: "Réponse interrompue" };
    }
    return { receipt: { ids: ["brief"], summary: "Tâche enregistrée." } };
  });
  const run = vi.fn<Parameters<typeof coachHandler>[2]>(async (_id, _context, prompt) => {
    if (prompt.includes('"message":"Découpons"')) {
      expect(prompt).toContain('"projetChoisi":"client"');
      return JSON.stringify({
        message: "Commençons par le brief.",
        tasks: [
          {
            projectId: "client",
            taskId: "brief",
            edit: { title: "Relire le brief", subtasks: [], criteria: "", today: false },
          },
          {
            projectId: "client",
            edit: { title: "Envoyer le brief", subtasks: [], criteria: "", today: false },
          },
        ],
      });
    }
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
  let list: () => Promise<ReturnType<typeof coachList.output.parse>> = async () => {
    throw new Error("Coach list RPC was not registered");
  };
  const context = {} as PluginHandlerContext;
  const server = {
    handle(
      rpc: typeof coachAction | typeof coachList,
      handler: (
        input:
          | ReturnType<typeof coachAction.input.parse>
          | ReturnType<typeof coachList.input.parse>,
        context: PluginHandlerContext,
      ) => unknown,
    ) {
      if (rpc.name === coachList.name) {
        list = async () =>
          coachList.output.parse(await handler(coachList.input.parse({}), context));
      } else if (rpc.name === coachAction.name) {
        invoke = async (input) =>
          coachAction.output.parse(await handler(coachAction.input.parse(input), context));
      }
    },
  } as PluginServerContext;
  const emptyHome = join(home, "empty");
  await mkdir(emptyHome);
  const stopEmpty = coachHandler(server, sequence, run, { read, apply }, emptyHome);
  try {
    expect(await list()).toEqual([]);
    expect(await list()).toEqual([]);
    expect(await readdir(emptyHome)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  } finally {
    await stopEmpty();
  }
  const legacyDb = new DatabaseSync(join(home, "projets-coach.sqlite3"));
  const legacyId = randomUUID();
  legacyDb.exec("CREATE TABLE coach (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  legacyDb.prepare("INSERT INTO coach VALUES (1, ?)").run(
    JSON.stringify({
      threadId: legacyId,
      revision: 3,
      skill: "day",
      lines: [],
      reflections: [],
    }),
  );
  legacyDb.close();
  let stop = coachHandler(server, sequence, run, { read, apply }, home, undefined, applyTask);
  try {
    let state = await invoke({ action: "read" });
    expect(state.threadId).toBe(legacyId);
    const send = (text: string) =>
      invoke({
        action: "send",
        threadId: state.threadId,
        revision: state.revision,
        timeZone,
        text,
      });
    async function finished(threadId: string) {
      return vi.waitFor(async () => {
        const current = await invoke({ action: "read", threadId });
        expect(current.busy).toBe(false);
        return current;
      });
    }
    async function start(skill: CoachSkill) {
      const threadId = randomUUID();
      await invoke({ action: "start", threadId, skill, timeZone });
      return finished(threadId);
    }
    const decision = (action: "confirm" | "reject") =>
      invoke({ action, threadId: state.threadId, revision: state.revision, id: draftId(state) });
    state = await send("J’ai 45 minutes avant mon rendez-vous, que puis-je avancer ?");
    expect(state.draft!.summary).toContain("09:00–09:45 (45 min)");
    const stale = {
      action: "confirm",
      threadId: state.threadId,
      revision: state.revision,
      id: draftId(state),
    };
    state = await send("30 minutes");
    expect(state.draft!.summary).toContain("09:00–09:30 (30 min)");
    await invoke(stale);
    state = await decision("reject");
    expect(state.draft).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();

    state = await send("30 minutes");
    moved = true;
    const oldId = draftId(state);
    state = await decision("confirm");
    expect(receipts.size).toBe(0);
    expect(draftId(state)).not.toBe(oldId);
    expect(state.draft!.summary).toContain("10:00–10:30 (30 min)");
    const newId = draftId(state);
    const revisionToReplay = state.revision;
    state = await decision("confirm");
    expect(state.error).toContain("Réessaie");
    expect(receipts.size).toBe(1);
    await stop();
    stop = coachHandler(server, sequence, run, { read, apply }, home, undefined, applyTask);
    state = await invoke({ action: "read" });
    expect(draftId(state)).toBe(newId);
    const confirmed = {
      action: "confirm",
      threadId: state.threadId,
      revision: revisionToReplay,
      id: newId,
    };
    state = await invoke(confirmed);
    expect(state.draft).toBeUndefined();
    expect((await invoke(confirmed)).lines.at(-1)?.text).toBe("Planning enregistré dans Things.");
    expect([...receipts]).toEqual([newId]);
    expect(apply.mock.calls.map(([draft]) => draft.id)).toEqual([oldId, newId, newId]);

    const legacy = state.threadId;
    state = await start("reflection");
    state = await decision("confirm");
    await stop();
    stop = coachHandler(server, sequence, run, { read, apply }, home, undefined, applyTask);
    state = await invoke({ action: "read" });
    expect((await invoke({ action: "read", threadId: legacy })).lines.at(0)?.text).toContain(
      "45 minutes",
    );
    expect(state.lines.at(-1)?.text).toBe("Bilan enregistré.");
    state = await start("week");
    expect(state.lines.at(-1)?.text).toContain("tu as déclaré");
    state = await start("season");
    expect(state.draft!.summary).toContain("Principal · Client · Dossier prêt");
    state = await decision("confirm");
    access = "denied";
    state = await start("day");
    expect(state.lines.at(-1)?.text).toBe("Agenda indisponible.\nRelis le brief en 30 minutes.");
    expect(state.draft).toBeUndefined();
    expect(receipts.size).toBe(1);

    access = "ready";
    const first = { action: "start", threadId: randomUUID(), skill: "day", timeZone } as const;
    const second = { ...first, threadId: randomUUID() };
    const earlier = Promise.withResolvers<string>();
    run.mockImplementationOnce((_id, _context, _prompt, _messageId, publish) => {
      publish("Réponse en cours");
      return earlier.promise;
    });
    const [firstView, secondView] = await Promise.all([invoke(first), invoke(second)]);
    expect(firstView.lines).toEqual([]);
    expect(secondView.lines).toEqual([]);
    expect(secondView.draft).toBeUndefined();
    expect((await invoke(first)).threadId).toBe(first.threadId);
    state = await finished(second.threadId);
    state = await send("30 minutes");
    expect(run.mock.lastCall![0]).toBe(second.threadId);
    expect(run.mock.lastCall![2]).toContain('"createdAt":"2029-12-17T09:00:00Z"');
    expect(run.mock.lastCall![2]).toContain('"title":"Revoir la conclusion","done":false');
    expect((await invoke({ action: "read", threadId: first.threadId })).preview).toBe(
      "Réponse en cours",
    );
    expect((await invoke({ action: "read", threadId: second.threadId })).preview).toBeUndefined();
    earlier.resolve(
      JSON.stringify({
        message: "Réponse de la première conversation.",
        changes: [
          {
            action: "create",
            taskId: "brief",
            start: "2030-01-07T10:30:00Z",
            end: "2030-01-07T10:40:00Z",
          },
        ],
      }),
    );
    const late = await finished(first.threadId);
    expect(late.lines.at(-1)?.text).toContain("première conversation");
    expect(late.draft).toBeUndefined();
    expect(late.preview).toBeUndefined();
    const latest = await invoke({ action: "read" });
    expect(latest.threadId).toBe(second.threadId);
    expect(draftId(latest)).toBe(draftId(state));
    expect(draftId(latest)).not.toBe(draftId(late));
    const writes = apply.mock.calls.length;
    await invoke({
      action: "confirm",
      threadId: latest.threadId,
      revision: latest.revision,
      id: randomUUID(),
    });
    expect(apply).toHaveBeenCalledTimes(writes);
    expect(run.mock.calls.filter(([id]) => id === first.threadId)).toHaveLength(1);
    state = await invoke({
      action: "send",
      threadId: state.threadId,
      revision: state.revision,
      timeZone,
      text: "Découpons",
      projectId: "client",
    });
    expect(state.draft?.kind).toBe("task");
    expect(state.draft?.kind === "task" && state.draft.proposal.existing).toEqual({
      id: "brief",
      version: "v1",
    });
    const decisionToReplay = {
      action: "confirm" as const,
      threadId: state.threadId,
      revision: state.revision,
      id: draftId(state),
      edit: {
        title: "Relire et corriger le brief",
        subtasks: ["Conclusion"],
        criteria: "Conclusion validée",
        today: true,
      },
    };
    state = await invoke(decisionToReplay);
    expect(state.canRetry).toBe(true);
    expect(draftId(state)).toBe(decisionToReplay.id);
    await stop();
    stop = coachHandler(server, sequence, run, { read, apply }, home, undefined, applyTask);
    state = await invoke(decisionToReplay);
    expect(state.lines.at(-1)?.text).toBe("Tâche enregistrée.");
    expect(state.draft?.kind === "task" && state.draft.proposal.edit.title).toBe(
      "Envoyer le brief",
    );
    expect(applyTask.mock.calls.map(([id, proposal]) => [id, proposal.edit])).toEqual([
      [decisionToReplay.id, decisionToReplay.edit],
      [decisionToReplay.id, decisionToReplay.edit],
    ]);
    state = await decision("reject");
    expect(state.draft).toBeUndefined();
    expect(state.lines.at(-1)?.text).toBe("Proposition passée.");
    expect(taskReceipts.size).toBe(1);
    const brief = "Brief complet\n" + "Un livrable par étape. ".repeat(250).trimEnd();
    state = await send(brief);
    expect(state.lines.at(-2)?.text).toBe(brief);
    const prompt = run.mock.lastCall![2];
    expect(prompt.split(JSON.stringify(brief))).toHaveLength(2);
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
      {
        action: "remove" as const,
        block: { id: "block-2", version: "v2" },
        start: "2030-01-07T12:00:00+01:00",
        end: "2030-01-07T12:30:00+01:00",
      },
    ];
    const draft = coachState.shape.draft.parse({
      kind: "plan",
      id,
      ...range,
      changes,
      summary: "Brief",
    });
    if (draft?.kind !== "plan") throw new Error("Brouillon absent");
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
      slot: { start: "2030-01-07T10:00:00Z", end: "2030-01-07T10:30:00Z" } },
      { kind: "remove", id: "block-2", version: "v2",
      slot: { start: "2030-01-07T11:00:00Z", end: "2030-01-07T11:30:00Z" } }] });
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
    expect(await thingsPlanning.apply(draft)).toEqual({ status: "conflict" });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming reveals only the coach message, including split JSON escapes", () => {
  expect(coachReplyPreview('{"mess')).toBeUndefined();
  expect(coachReplyPreview('{"message":"Premier point\\')).toBe("Premier point");
  expect(coachReplyPreview('{"message":"Premier point\\nSuite","tasks":[{')).toBe(
    "Premier point\nSuite",
  );
  expect(coachReplyPreview('{"message":"En cours \\ud83d')).toBe("En cours ");
  expect(coachReplyPreview('{"message":"En cours \\ud83d\\ude42')).toBe("En cours 🙂");
});

test("all coaches share memory, protect a concurrent edit, and follow up only on an attempted review", async () => {
  const home = await mkdtemp(join(tmpdir(), "projets-coach-profile-"));
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-07T10:00:00Z"));
  type Handler = (input: unknown, context: PluginHandlerContext) => unknown;
  const handlers = new Map<string, Handler>();
  const server = {
    handle(rpc: { name: string }, handler: Handler) {
      handlers.set(rpc.name, handler);
    },
  } as PluginServerContext;
  const context = {} as PluginHandlerContext;
  const call = async (method: string, input: unknown) => handlers.get(method)!(input, context);
  const invoke = async (input: Parameters<typeof coachAction.input.parse>[0]) =>
    coachAction.output.parse(await call(coachAction.name, input));
  const memory = async (text?: string) =>
    coachMemory.output.parse(await call(coachMemory.name, { text }));
  const seen: string[] = [];
  let started = () => {};
  let finish = () => {};
  const pause = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const enter = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run: Parameters<typeof coachHandler>[2] = async (_id, _context, prompt) => {
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    seen.push(data.memoireDuCoach);
    if (data.message === "Retiens que je préfère les blocs d’une heure.") {
      return JSON.stringify({ message: "D’accord.", memoryUpdate: "Blocs d’une heure." });
    }
    if (data.message === "Retiens que je commence à neuf heures.") {
      started();
      await pause;
      return JSON.stringify({ message: "D’accord.", memoryUpdate: "Écriture périmée" });
    }
    if (data.ajustementCetteSemaine === undefined && data.observationEnergie.length) {
      return JSON.stringify({
        message: "Revue.",
        adjustment: "Garde une heure libre chaque jour.",
      });
    }
    return JSON.stringify({
      message: "Priorité du jour.",
      suggestedSlot: { start: "2030-01-07T11:00:00Z", end: "2030-01-07T11:30:00Z" },
    });
  };
  const attach = () =>
    coachHandler(
      server,
      async () => ({ sequence: { day: 20300107, projects: [], rows: [] } }),
      run,
      {
        read: async () => ({
          access: "ready",
          blocks: [],
          events: [
            {
              id: "busy",
              title: "Occupé",
              busy: true,
              start: "2030-01-07T10:45:00Z",
              end: "2030-01-07T11:15:00Z",
            },
          ],
        }),
        apply: async () => ({ status: "applied" }),
      },
      home,
    );
  const start = async (skill: CoachSkill) => {
    const threadId = randomUUID();
    let state = await invoke({ action: "start", skill, threadId, timeZone: "UTC" });
    while (state.busy) {
      await new Promise((resolve) => setImmediate(resolve));
      state = await invoke({ action: "read", threadId });
    }
    return state;
  };
  let stop = attach();
  try {
    expect((await memory()).text).toContain("90 minutes");
    await memory("Mon texte.");
    for (const kind of ["day", "reflection", "week", "season"] as const) {
      const thread = await start(kind);
      expect(seen.at(-1)).toBe("Mon texte.");
      expect(thread.lines.at(-1)?.text).not.toContain("Créneau proposé");
    }
    let thread = await start("day");
    const send = (text: string) =>
      invoke({
        action: "send",
        threadId: thread.threadId,
        revision: thread.revision,
        text,
        timeZone: "UTC",
      });
    thread = await send("Retiens que je préfère les blocs d’une heure.");
    expect((await memory()).text).toBe("Blocs d’une heure.");
    const stale = send("Retiens que je commence à neuf heures.");
    await enter;
    await memory("Saisie de Sylvain.");
    finish();
    expect((await stale).lines.at(-1)?.text).toContain("Redemande-moi");
    expect((await memory()).text).toBe("Saisie de Sylvain.");
    await memory("");
    await stop();
    stop = attach();
    expect((await memory()).text).toBe("");
    for (const kind of ["day", "reflection", "week", "season"] as const) {
      await start(kind);
      expect(seen.at(-1)).toBe("");
    }
    const entry = { id: "task:1", title: "Devis", date: "2030-01-07T09:00:00Z" };
    expect(await call(coachEnergy.name, { entry })).toEqual([entry]);
    await call(coachEnergy.name, { entry: { ...entry, value: "more" } });
    await call(coachEnergy.name, { entry: { ...entry, value: "less" } });
    expect(await call(coachEnergy.name, { entry })).toEqual([{ ...entry, value: "less" }]);
    const first = await start("week");
    expect(first.adjustment?.text).toContain("une heure libre");
    expect(await call(coachReview.name, { week: first.adjustment?.week, decision: "try" })).toBe(
      true,
    );
    now.mockReturnValue(Date.parse("2030-01-14T10:00:00Z"));
    await call(coachEnergy.name, {
      entry: { ...entry, id: "task:2", date: "2030-01-14T09:00:00Z", value: "same" },
    });
    const second = await start("week");
    expect(second.followUp?.week).toBe(first.adjustment?.week);
    expect(await call(coachReview.name, { week: second.followUp?.week, helpful: true })).toBe(true);
    expect(await call(coachReview.name, { week: second.adjustment?.week, decision: "pass" })).toBe(
      true,
    );
    now.mockReturnValue(Date.parse("2030-01-21T10:00:00Z"));
    const third = await start("week");
    expect(third.followUp).toBeUndefined();
  } finally {
    finish();
    await stop();
    now.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});

test("a message arriving during hibernation stays in the same conversation", async () => {
  const home = await mkdtemp(join(tmpdir(), "projets-coach-rest-"));
  type Handler = (input: unknown, context: PluginHandlerContext) => unknown;
  let action!: Handler;
  const server = {
    handle(rpc: { name: string }, handler: Handler) {
      if (rpc.name === coachAction.name) action = handler;
    },
  } as PluginServerContext;
  const invoke = async (input: Parameters<typeof coachAction.input.parse>[0]) =>
    coachAction.output.parse(await action(input, {} as PluginHandlerContext));
  let releaseStarted!: () => void;
  let finishRelease!: () => void;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const pause = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  const run = vi.fn<Parameters<typeof coachHandler>[2]>(async () =>
    JSON.stringify({ message: "Réponse." }),
  );
  const stop = coachHandler(
    server,
    async () => ({ sequence: { day: 20300107, projects: [], rows: [] } }),
    run,
    {
      read: async () => ({ access: "ready", blocks: [], events: [] }),
      apply: async () => ({ status: "applied" }),
    },
    home,
    undefined,
    undefined,
    async () => {
      releaseStarted();
      await pause;
    },
  );
  const threadId = randomUUID();
  try {
    await invoke({ action: "start", skill: "day", threadId, timeZone: "UTC" });
    await started;
    const saved = await invoke({ action: "read", threadId });
    expect(saved.busy).toBe(false);
    expect(saved.lines.filter((line) => line.kind === "answer")).toHaveLength(1);

    const input = {
      action: "send" as const,
      threadId,
      timeZone: "UTC",
      revision: saved.revision,
      text: "La suite.",
    };
    const message = invoke(input);
    const duplicate = invoke(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);
    finishRelease();
    await Promise.all([message, duplicate]);
    const resumed = await invoke({ action: "read", threadId });
    expect(resumed.threadId).toBe(threadId);
    expect(resumed.lines.filter((line) => line.text === input.text)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    finishRelease();
    await stop();
    await rm(home, { recursive: true, force: true });
  }
});
