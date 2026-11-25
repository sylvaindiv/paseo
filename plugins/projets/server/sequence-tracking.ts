import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  sequenceActivity,
  sequenceAssociation,
  sequenceTracking,
  type SequenceRun,
} from "../shared/sequence.js";
import { batchLabel, type BatchObservation } from "../shared/project-todos.js";

export function registerSequenceTracking(
  server: PluginServerContext,
  home = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
) {
  let database: DatabaseSync | undefined;
  function db() {
    if (database) return database;
    const connection = new DatabaseSync(join(home, "projets-sequence.sqlite3"));
    connection.exec(`
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS project_links (project TEXT PRIMARY KEY, destination TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (task TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
    `);
    database = connection;
    return connection;
  }

  function save(task: string, run: SequenceRun) {
    db()
      .prepare(`
      INSERT INTO runs(task,id,body) VALUES(?,?,?)
      ON CONFLICT(task) DO UPDATE SET id=excluded.id, body=excluded.body
    `)
      .run(task, run.id, JSON.stringify(run));
    return run;
  }

  function observe(
    task: string,
    run: SequenceRun | null,
    state: BatchObservation,
    turnId?: string,
  ) {
    if (
      !run ||
      run.state === "review" ||
      run.state === "failed" ||
      (run.state === "launching" && state === "unknown") ||
      (run.turnId && run.turnId !== turnId)
    )
      return run;
    return save(task, { ...run, state, turnId: turnId ?? run.turnId });
  }

  function decode(body: unknown) {
    return typeof body === "string" ? sequenceTracking.output.parse(JSON.parse(body)) : null;
  }

  function transaction<T>(operation: () => T) {
    const connection = db();
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  function linkedProject(project: string) {
    const value = db()
      .prepare("SELECT destination FROM project_links WHERE project=?")
      .get(project)?.destination;
    return typeof value === "string" ? value : null;
  }

  server.handle(sequenceAssociation, (input) => {
    if (input.action === "read") return linkedProject(input.project);
    if (input.destination === null)
      db().prepare("DELETE FROM project_links WHERE project=?").run(input.project);
    else
      db()
        .prepare(`
        INSERT INTO project_links(project,destination) VALUES(?,?)
        ON CONFLICT(project) DO UPDATE SET destination=excluded.destination
      `)
        .run(input.project, input.destination);
    return input.destination;
  });

  server.handle(sequenceActivity, () =>
    sequenceActivity.output.parse(
      db()
        .prepare(`
      SELECT task, id AS agentId, json_extract(body, '$.destination.serverId') AS serverId
      FROM runs WHERE json_extract(body, '$.state') = 'running'
    `)
        .all(),
    ),
  );

  server.handle(sequenceTracking, async (input, { paseo }) => {
    const read = () =>
      decode(db().prepare("SELECT body FROM runs WHERE task=?").get(input.task)?.body);
    if (input.action === "read") return read();
    if (input.action === "observe")
      return transaction(() => {
        const run = read();
        return run?.id === input.id ? observe(input.task, run, input.state, input.turnId) : null;
      });
    const space = await paseo.workspaces.ref(input.run.destination.workspaceId).refresh();
    if (!space || space.archivingAt) throw new Error("Cet espace n’est plus disponible.");
    return transaction(() => {
      const destination = linkedProject(input.project);
      if (!destination || destination !== space.projectId)
        throw new Error("Cet espace ne fait plus partie du projet associé.");
      const run = read();
      if (run?.id !== input.previous || (run && run.state !== "failed"))
        throw new Error("Cette tâche a déjà été confiée à un agent.");
      return save(input.task, { ...input.run, taskIds: [input.task], state: "launching" });
    });
  });
  const observeAgent = (id: string, state: BatchObservation, turnId?: string) =>
    transaction(() => {
      const entry = db().prepare("SELECT task,body FROM runs WHERE id=?").get(id);
      if (typeof entry?.task === "string") observe(entry.task, decode(entry.body), state, turnId);
    });
  const offStart = server.on("agent.turn_started", ({ agent, turnId }) => {
    if (agent.labels[batchLabel] === agent.id)
      observeAgent(agent.id, "running", turnId ?? undefined);
  });
  const offEnd = server.on("agent.turn_ended", ({ agent, turnId, outcome }) => {
    if (agent.labels[batchLabel] === agent.id)
      observeAgent(
        agent.id,
        outcome.kind === "completed" ? "review" : "failed",
        turnId ?? undefined,
      );
  });
  return () => {
    offStart();
    offEnd();
    database?.close();
  };
}
