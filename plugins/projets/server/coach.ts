import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { coachAction, coachReply, coachState, type CoachState } from "../shared/coach.js";
import { completedTasks } from "./coach-completed.js";
import { dateIn, offsetDay, preparePlan, thingsPlanning } from "./coach-planning.js";
import { coachInstructions, instructions } from "./coach-skills.js";
import type { registerSequence } from "./sequence.js";
import type { registerTaskCapture } from "./task-capture.js";

type OpenAgent = ReturnType<typeof registerTaskCapture>["open"];
type ReadSequence = ReturnType<typeof registerSequence>["read"];
type RunCoach = (
  threadId: string,
  context: PluginHandlerContext,
  prompt: string,
  messageId: string,
) => Promise<string>;

export function registerCoach(
  server: PluginServerContext,
  sequence: ReadSequence,
  open: OpenAgent,
  home = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
) {
  return coachHandler(
    server,
    sequence,
    async (id, { paseo }, prompt, messageId) => {
      const ref = paseo.agents.ref(id);
      const agent = (await ref.refresh()) ? ref : await open(id, paseo, "Coach", coachInstructions);
      let reply = await agent.run(prompt, { messageId, timeoutMs: 60_000 });
      if (reply.status === "timeout") reply = await agent.waitForFinish(60_000);
      if (reply.status !== "idle" || !reply.lastMessage) throw new Error("Réponse indisponible.");
      return reply.lastMessage;
    },
    thingsPlanning,
    home,
  );
}

export function coachHandler(
  server: PluginServerContext,
  sequence: ReadSequence,
  run: RunCoach,
  planning: typeof thingsPlanning,
  home: string,
) {
  let database: DatabaseSync | undefined;
  let working: Promise<unknown> | undefined;
  function db() {
    database ??= new DatabaseSync(join(home, "projets-coach.sqlite3"));
    database.exec("CREATE TABLE IF NOT EXISTS coach (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    return database;
  }
  function read(): CoachState {
    const body = db().prepare("SELECT body FROM coach WHERE id=1").get()?.body;
    return typeof body === "string"
      ? coachState.parse(JSON.parse(body))
      : {
          threadId: randomUUID(),
          revision: 0,
          skill: "day",
          lines: [],
          reflections: [],
        };
  }
  function save(state: CoachState) {
    state.revision++;
    db().prepare("INSERT OR REPLACE INTO coach(id, body) VALUES(1, ?)").run(JSON.stringify(state));
  }
  function message(state: CoachState, text: string, kind: "you" | "answer" = "answer") {
    state.lines.push({ id: randomUUID(), kind, text });
  }

  // oxlint-disable-next-line complexity -- Each skill can produce only its own draft.
  async function reply(state: CoachState, context: PluginHandlerContext) {
    const pending = state.pending!;
    const now = Date.now();
    const { timeZone } = pending;
    const today = dateIn(now, timeZone);
    const range = {
      from: state.skill === "week" ? offsetDay(today, -6) : today,
      to: offsetDay(today, 1),
      timeZone,
    };
    const [things, snapshot] = await Promise.all([
      sequence(),
      state.skill === "season" ? undefined : planning.read(range),
    ]);
    if (!things.sequence) throw new Error("Bibliothèque indisponible.");
    const { projects, rows } = things.sequence;
    const tasks = rows.filter((row) => row.kind === "task");
    const completed = ["week", "reflection"].includes(state.skill)
      ? completedTasks(range)
      : undefined;
    const activeSeason =
      state.season && state.season.from <= today && today <= state.season.through;
    const displayTime = new Intl.DateTimeFormat("fr-FR", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
    const raw = await run(
      state.threadId,
      context,
      [
        instructions[state.skill],
        JSON.stringify({
          message: pending.text,
          today,
          now: new Date(now).toISOString(),
          heureLocale: displayTime,
          range,
          snapshot,
          projets: projects.map(({ id, title, status, deadline }, index) => ({
            rangSequence: index + 1,
            id,
            title,
            status,
            deadline,
          })),
          taches: tasks.map(
            ({ id, title, parent, today: scheduledToday, deadline, eligible, someday }) => ({
              id,
              title,
              parent,
              today: scheduledToday,
              deadline,
              eligible,
              someday,
            }),
          ),
          terminees: completed,
          bilans:
            state.skill === "week"
              ? state.reflections.filter(({ date }) => date >= range.from && date < range.to)
              : undefined,
          saison: activeSeason ? state.season : undefined,
          discussion: state.lines.slice(-20).map(({ kind, text }) => ({ kind, text })),
        }),
      ].join("\n"),
      pending.id,
    );
    pending.id = randomUUID();
    const output = coachReply.parse(
      JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")),
    );

    if (state.skill === "day" && output.changes?.length && snapshot?.access === "ready") {
      state.draft = {
        kind: "plan",
        id: randomUUID(),
        ...range,
        ...preparePlan(output.changes, range, snapshot, tasks, now),
      };
    }
    if (state.skill === "reflection" && output.reflection) {
      const allowedTasks = new Set([...tasks, ...(completed ?? [])].map((task) => task.id));
      const allowedProjects = new Set([
        ...projects.map(({ id }) => id),
        ...(completed ?? []).map((task) => task.projectId),
      ]);
      const { done, obstacles, energy, taskIds, projectIds } = output.reflection;
      state.draft = {
        kind: "reflection",
        id: randomUUID(),
        date: today,
        done,
        obstacles,
        energy,
        taskIds: taskIds.filter((id) => allowedTasks.has(id)),
        projectIds: projectIds.filter((id) => allowedProjects.has(id)),
        summary: `Réalisé · ${done}\nObstacles · ${obstacles}\nÉnergie · ${energy}`,
      };
    }
    if (state.skill === "season" && output.season) {
      const { from, through, goal, priorities } = output.season;
      const titles = new Map(projects.map(({ id, title }) => [id, title]));
      if (
        from > through ||
        new Set(priorities.map((p) => p.projectId)).size !== priorities.length ||
        priorities.some((p) => !titles.has(p.projectId))
      )
        throw new Error("Objectifs à préciser.");
      const levels = { main: "Principal", secondary: "Secondaire", maintain: "À entretenir" };
      state.draft = {
        ...output.season,
        kind: "season",
        id: randomUUID(),
        summary: [
          `${from} → ${through}`,
          goal,
          ...priorities.map(
            (p) => `${levels[p.level]} · ${titles.get(p.projectId)} · ${p.outcome}`,
          ),
        ].join("\n"),
      };
    }
    const warning = snapshot && snapshot.access !== "ready" ? "Agenda indisponible.\n" : "";
    message(state, warning + output.message + (state.draft ? "\n\n" + state.draft.summary : ""));
    state.pending = undefined;
  }

  async function confirm(state: CoachState, context: PluginHandlerContext) {
    const draft = state.draft!;
    if (draft.kind === "reflection") {
      state.reflections = [...state.reflections.filter(({ date }) => date !== draft.date), draft];
      message(state, "Bilan enregistré.");
    } else if (draft.kind === "season") {
      state.season = draft;
      message(state, "Saison enregistrée.");
    } else {
      const expired =
        !draft.applying && draft.changes.some(({ start }) => Date.parse(start) < Date.now());
      let status: Awaited<ReturnType<typeof planning.apply>>["status"] = "conflict";
      if (!expired) {
        draft.applying = true;
        save(state);
        ({ status } = await planning.apply(draft));
      }
      if (status === "conflict") {
        state.draft = undefined;
        message(state, "Le planning a changé. Je vérifie les créneaux.");
        state.pending = {
          id: randomUUID(),
          timeZone: draft.timeZone,
          text: "Le brouillon précédent est périmé. Vérifie l’agenda actualisé et propose un autre créneau.",
        };
        save(state);
        await reply(state, context);
        return;
      }
      message(
        state,
        status === "applied" ? "Planning enregistré dans Things." : "Agenda indisponible.",
      );
    }
    state.draft = undefined;
  }

  server.handle(coachAction, async (input, context) => {
    const state = read();
    const view = (busy = Boolean(working)) => ({
      ...state,
      busy,
      canRetry: Boolean(state.pending && !busy),
    });
    if (input.action === "read" || working || input.revision !== state.revision) return view();
    const applying = state.draft?.kind === "plan" && state.draft.applying;
    if (applying && input.action !== "confirm") return view();
    if ("id" in input && state.draft?.id !== input.id) return view();
    state.error = undefined;
    if (input.action === "reject") {
      state.draft = undefined;
      message(state, "Proposition refusée.");
      save(state);
      return view();
    }
    if (input.action === "send") {
      state.skill = input.skill ?? state.skill;
      state.draft = undefined;
      state.pending = { id: randomUUID(), text: input.text, timeZone: input.timeZone };
      message(state, input.text, "you");
      save(state);
    }
    if (input.action === "retry" && !state.pending) return view();
    working = (input.action === "confirm" ? confirm(state, context) : reply(state, context)).catch(
      () => {
        state.error =
          state.draft?.kind === "plan" && state.draft.applying
            ? "Validation à vérifier. Réessaie."
            : "Réponse indisponible. Réessaie.";
      },
    );
    try {
      await working;
      save(state);
      return view(false);
    } finally {
      working = undefined;
    }
  });
  return async () => {
    await working;
    database?.close();
  };
}
