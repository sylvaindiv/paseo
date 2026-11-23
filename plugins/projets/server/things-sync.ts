import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { watch, type FSWatcher, readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { spawn } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  applyPatch,
  chooseThings,
  relinkThings,
  diffRows,
  exchangeThings,
  fields,
  same,
  waitThings,
  type Conflict,
  type Entity,
  type Field,
  type Patch,
  type Rows,
} from "../shared/things.js";
import {
  createThingsHeading,
  readThings,
  thingsCli,
  thingsImport,
  thingsScript,
  type Links,
} from "./things-db.js";

interface StoredConflict extends Conflict {
  local: Entity | null;
  remote: Entity | null;
}
interface ChecklistWrite {
  ids: string[];
  values: { title: string; done: boolean }[];
  before: string;
  sent: boolean;
}
interface State {
  rows: Rows;
  base: Rows;
  links: Links;
  detached: string[];
  distinct?: string[];
  detachedBase?: Rows;
  conflicts: StoredConflict[];
  pending: Record<string, string>;
  sent?: string[];
  checklists?: Record<string, ChecklistWrite>;
  area: string;
}
interface Config {
  headingShortcut?: string;
  binary: string;
  area: string;
}
function loadConfig(home: string) {
  try {
    return z
      .object({
        binary: z.string().min(1),
        area: z.string().min(1),
        headingShortcut: z.string().min(1).optional(),
      })
      .parse(JSON.parse(readFileSync(join(home, "things-sync.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function display(row: Entity | null, field: string) {
  if (!row) return "Supprimé";
  if (!fields.includes(field as Field)) return row.title;
  return String(row[field as Field] ?? "");
}
function setRow(rows: Rows, id: string, row: Entity | null) {
  if (row) rows[id] = row;
  else delete rows[id];
}
function projectOf(row: Entity, rows: Rows) {
  let parent: Entity | undefined = row;
  for (let level = 0; parent && level < 4; level++) {
    if (parent.kind === "project") return parent.id;
    parent = rows[parent.parent ?? ""];
  }
  return null;
}
function recordConflict(
  state: State,
  id: string,
  field: string,
  local: Entity | null,
  remote: Entity | null,
) {
  state.conflicts = state.conflicts.filter((c) => c.id !== id || c.field !== field);
  state.conflicts.push({
    id,
    field,
    local,
    remote,
    paseo: display(local, field),
    things: display(remote, field),
  });
}

function childrenOf(rows: Rows, task: string) {
  return Object.values(rows).filter((row) => row.kind === "child" && row.parent === task);
}
function checklistLabel(rows: Rows, task: string) {
  return (
    Object.values(rows)
      .filter((r) => r.kind === "child" && r.parent === task)
      .map((r) => (r.done ? "☑ " : "☐ ") + r.title)
      .join(" · ") || "Vide"
  );
}

// Import a complete snapshot and retain the last common value until a write is confirmed.
export function pullThings(state: State, remote: Rows) {
  const prior = state.base;
  for (const row of Object.values(prior)) {
    if (row.kind === "project" && !remote[row.id] && !state.detached.includes(row.id)) {
      state.detached.push(row.id);
      for (const saved of Object.values(prior))
        if (projectOf(saved, prior) === row.id) (state.detachedBase ??= {})[saved.id] = saved;
    }
  }
  for (const { before, after } of diffRows(prior, remote)) {
    const row = (before ?? after)!;
    if (state.detached.includes(projectOf(row, after ? remote : prior) ?? "")) continue;
    if (
      row.kind === "child" &&
      state.conflicts.some((c) => c.id === row.parent && c.field === "checklist")
    )
      continue;
    const local = state.rows[row.id] ?? null;
    const changes: string[] = [];
    const merged = applyPatch(local, { before, after }, (f) => changes.push(f));
    setRow(state.rows, row.id, merged);
    for (const field of changes) recordConflict(state, row.id, field, local, after);
  }
  state.base = remote;
  state.conflicts = state.conflicts.filter((c) => {
    if (c.field === "checklist") {
      if (!remote[c.id] || !state.rows[c.id]) return false;
      c.paseo = checklistLabel(state.rows, c.id);
      c.things = checklistLabel(remote, c.id);
      return true;
    }
    if (c.field.startsWith("match:") || c.field === "browser") return true;
    const local = state.rows[c.id] ?? null,
      other = remote[c.id] ?? null;
    if (c.field === "item") return !same(local, other);
    return local?.[c.field as Field] !== other?.[c.field as Field];
  });
}
function orderedChanges(remote: Rows, local: Rows) {
  const ranks = ["project", "phase", "task", "child"];
  function rank(p: Patch) {
    return p.after ? ranks.indexOf(p.after.kind) : 7 - ranks.indexOf(p.before!.kind);
  }
  return diffRows(remote, local).sort((a, b) => rank(a) - rank(b));
}
function reparent(rows: Rows, from: string, to: string) {
  for (const row of Object.values(rows)) if (row.parent === from) row.parent = to;
}
function initial(): State {
  return { rows: {}, base: {}, links: {}, detached: [], conflicts: [], pending: {}, area: "" };
}
export function registerThings(server: PluginServerContext, home: string) {
  let config: Config | null = null;
  let configurationError = "";
  try {
    if (process.platform === "darwin") config = loadConfig(home);
  } catch {
    configurationError = "Vérifie les réglages de Things.";
  }
  let db: DatabaseSync | undefined;
  let state = initial(),
    version = randomUUID(),
    message = configurationError,
    filename = "",
    closed = false;
  let watcher: FSWatcher | undefined, wake: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    worker: Promise<void> | undefined,
    dirty = false,
    failures = 0;
  const listeners = new Set<() => void>();
  const signal = () => {
    version = randomUUID();
    for (const l of listeners) l();
  };
  function save() {
    db?.prepare("UPDATE things_sync SET data=? WHERE id=1").run(JSON.stringify(state));
    signal();
  }
  function status(text: string) {
    if (message !== text) {
      message = text;
      signal();
    }
  }
  function schedule(delay = 120) {
    if (!config || closed) return;
    dirty = true;
    if (worker || (timer && delay > 0)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      worker = run().finally(() => {
        worker = undefined;
        if (dirty && !closed) schedule(failures ? Math.min(60000, 2000 * failures) : 120);
      });
    }, delay);
  }
  function snapshot() {
    return {
      enabled: !!config,
      detached: state.detached.map((id) => ({ id, title: state.rows[id]?.title ?? id })),
      revision: version,
      rows: Object.values(state.rows),
      conflicts: state.conflicts.map(({ id, field, paseo, things }) => ({
        id,
        field,
        paseo,
        things,
      })),
      message,
    };
  }
  server.handle(exchangeThings, ({ edits }) => {
    if (config && edits.length) {
      for (const edit of edits) {
        const row = edit.after ?? edit.before;
        if (
          !row ||
          (edit.before &&
            edit.after &&
            (edit.before.id !== edit.after.id || edit.before.kind !== edit.after.kind))
        )
          throw new Error("Modification invalide.");
        const current = state.rows[row.id] ?? null;
        const merged = applyPatch(current, edit, () =>
          recordConflict(state, row.id, "browser", edit.after, current),
        );
        setRow(state.rows, row.id, merged);
      }
      save();
      schedule(0);
    }
    return snapshot();
  });
  server.handle(waitThings, async ({ revision }) => {
    if (config && !closed && revision === version) {
      let notify!: () => void;
      const pending = new Promise<void>((resolve) => {
        notify = resolve;
      });
      listeners.add(notify);
      const timeout = setTimeout(notify, 18000);
      try {
        await pending;
      } finally {
        clearTimeout(timeout);
        listeners.delete(notify);
      }
    }
    return version;
  });
  server.handle(relinkThings, ({ id }) => {
    if (!config || !state.detached.includes(id)) return false;
    const remote = readThings(filename, config.area, state.links).rows;
    const old = state.detachedBase ?? {};
    for (const row of Object.values(state.rows)) {
      if (projectOf(row, state.rows) !== id) continue;
      delete state.base[row.id];
      if (remote[id] && old[row.id]) state.base[row.id] = old[row.id]!;
      if (!remote[id]) delete state.links[row.id];
      delete old[row.id];
    }
    state.detached = state.detached.filter((key) => key !== id);
    save();
    schedule(0);
    return true;
  });
  server.handle(chooseThings, ({ id, field, choice, revision }) => {
    if (revision !== version) return false;
    const conflict = state.conflicts.find((c) => c.id === id && c.field === field);
    if (!conflict) return false;
    if (field.startsWith("match:")) {
      if (choice === "things" && conflict.remote && conflict.local) {
        // The user explicitly associates the two homonyms. Keep the children of both projects.
        const imported = conflict.remote.id,
          existing = conflict.local.id;
        state.links[existing] = state.links[imported]!;
        delete state.links[imported];
        delete state.rows[imported];
        delete state.base[imported];
        reparent(state.rows, imported, existing);
        reparent(state.base, imported, existing);
        state.base[existing] = { ...conflict.remote, id: existing };
        delete state.pending[existing];
      } else {
        state.pending[id] = randomUUID();
        (state.distinct ??= []).push(id);
      }
    } else if (field === "checklist") {
      if (choice === "things") {
        for (const row of childrenOf(state.rows, id)) delete state.rows[row.id];
        for (const row of childrenOf(state.base, id)) state.rows[row.id] = row;
      }
    } else {
      const selected = choice === "paseo" ? conflict.local : conflict.remote;
      if (field === "item" || field === "browser") setRow(state.rows, id, selected);
      else if (state.rows[id] && selected)
        Object.assign(state.rows[id]!, { [field]: selected[field as Field] });
    }
    state.conflicts = state.conflicts.filter(
      (c) =>
        c !== conflict &&
        !(field.startsWith("match:") && c.field.startsWith("match:") && c.id === id),
    );
    save();
    schedule();
    return true;
  });

  async function connect(cfg: Config) {
    const report = await thingsCli(cfg.binary, ["doctor"]);
    if (!report?.ok || typeof report.database !== "string")
      throw new Error("Base Things indisponible.");
    if (closed) return;
    filename = report.database;
    if (state.area && state.area !== cfg.area) throw new Error("Le domaine Things a changé.");
    state.area = cfg.area;
    watcher = watch(dirname(filename), (_, file) => {
      if (!file || file === basename(filename) || file === basename(filename) + "-wal")
        schedule(250);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      schedule(500);
    });
  }

  function recoverCreates(data: ReturnType<typeof readThings>) {
    let didRecover = false;
    for (const [id, token] of Object.entries(state.pending)) {
      const local = state.rows[id];
      if (!local) continue;
      const matches = Object.values(data.rows).filter(
        (row) =>
          row.title === "Paseo " + token && row.kind === local.kind && row.parent === local.parent,
      );
      if (matches.length > 1) throw new Error("Création Things ambiguë.");
      const found = matches[0];
      if (!found) continue;
      const uuid = data.assigned[found.id] ?? state.links[found.id];
      if (!uuid) throw new Error("Identifiant Things manquant.");
      state.links[id] = uuid;
      state.base[id] = { ...found, id };
      if (found.kind === "project" || found.kind === "task") {
        const locals = Object.values(state.rows).filter(
          (r) => r.parent === id && (r.kind === "phase" || r.kind === "child"),
        );
        const remote = Object.values(data.rows).filter((r) => r.parent === found.id);
        for (const actual of remote) {
          const at = locals.findIndex(
            (r) => r.kind === actual.kind && r.title === actual.title && r.done === actual.done,
          );
          const expected = locals[at],
            childUuid = data.assigned[actual.id];
          if (!expected || !childUuid) continue;
          locals.splice(at, 1);
          state.links[expected.id] = childUuid;
          state.base[expected.id] = { ...actual, id: expected.id, parent: id };
        }
      }
      delete state.pending[id];
      state.sent = state.sent?.filter((key) => key !== id);
      didRecover = true;
    }
    if (didRecover) save();
    return didRecover;
  }
  function recoverChecklists(data: ReturnType<typeof readThings>) {
    let found = false;
    for (const [task, write] of Object.entries(state.checklists ?? {})) {
      const children = Object.values(data.rows).filter(
        (r) => r.parent === task && r.kind === "child",
      );
      if (
        JSON.stringify(children.map((c) => ({ title: c.title, done: !!c.done }))) !==
        JSON.stringify(write.values)
      ) {
        if (
          JSON.stringify(
            children.map((c) => [state.links[c.id] ?? data.assigned[c.id], c.title, !!c.done]),
          ) !== write.before
        ) {
          recordConflict(
            state,
            task,
            "checklist",
            state.rows[task] ?? null,
            data.rows[task] ?? null,
          );
          delete state.checklists![task];
          found = true;
        }
        continue;
      }
      for (const [key, row] of Object.entries(state.base))
        if (row.kind === "child" && row.parent === task) {
          delete state.base[key];
          delete state.links[key];
        }
      children.forEach((row, i) => {
        const key = write.ids[i]!,
          uuid = data.assigned[row.id] ?? data.uuidByKey[row.id];
        if (!uuid) throw new Error("Sous-tâche non confirmée.");
        state.links[key] = uuid;
        state.base[key] = { ...row, id: key };
      });
      delete state.checklists![task];
      found = true;
    }
    if (found) save();
    return found;
  }
  async function updateChecklist(cfg: Config, task: string, remote: Rows, warnings: string[]) {
    if (!state.rows[task] || !state.base[task] || !state.links[task]) return false;
    if (
      state.conflicts.some(
        (c) =>
          (c.id === task && c.field === "checklist") ||
          c.local?.parent === task ||
          c.remote?.parent === task,
      )
    )
      return false;
    const old = Object.values(remote).filter((r) => r.parent === task && r.kind === "child");
    const changed = Object.values(state.rows).filter(
      (r) => r.parent === task && r.kind === "child",
    );
    // Replace only on a content edit. Preserve Things' order and append new lines.
    const ordered = [
      ...old.flatMap((r) => (state.rows[r.id] ? [state.rows[r.id]!] : [])),
      ...changed.filter((r) => !remote[r.id]),
    ];
    if (ordered.length > 100) {
      warnings.push("Things accepte 100 sous-tâches par tâche.");
      return false;
    }
    const writes = (state.checklists ??= {});
    const values = ordered.map((r) => ({ title: r.title, done: !!r.done }));
    const entry = (writes[task] ??= {
      ids: ordered.map((r) => r.id),
      values,
      before: JSON.stringify(old.map((r) => [state.links[r.id], r.title, !!r.done])),
      sent: false,
    });
    if (entry.sent) {
      warnings.push("Vérifie les sous-tâches de « " + state.rows[task]!.title + " ».");
      return false;
    }
    entry.sent = true;
    save();
    await thingsImport(cfg.binary, [
      {
        type: "to-do",
        operation: "update",
        id: state.links[task],
        attributes: {
          "checklist-items": entry.values.map((r) => ({
            type: "checklist-item",
            attributes: { title: r.title, completed: r.done },
          })),
        },
      },
    ]);
    return true;
  }
  async function run() {
    if (!config || closed) return;
    dirty = false;
    try {
      if (!watcher) await connect(config);
      if (closed) return;
      let data = readThings(filename, config.area, state.links);
      if (recoverCreates(data)) data = readThings(filename, config.area, state.links);
      if (recoverChecklists(data)) data = readThings(filename, config.area, state.links);
      const prior = JSON.stringify(state);
      Object.assign(state.links, data.assigned);
      pullThings(state, data.rows);
      if (prior !== JSON.stringify(state)) save();
      const skipped: string[] = [];
      let failed = false;
      const pending = orderedChanges(data.rows, state.rows);
      for (const change of pending) {
        const item = (change.after ?? change.before)!;
        const project = projectOf(item, change.after ? state.rows : data.rows);
        if (!project || state.detached.includes(project) || blocked(item.id)) continue;
        try {
          const updated = await push(config, change, data.rows, skipped);
          if (updated) {
            dirty = true;
            break;
          }
        } catch {
          skipped.push("Envoi à vérifier dans Things · " + item.title);
          failed = true;
        }
      }
      status(skipped[0] ?? "");
      failures = Number(failed) * (failures + 1);
      dirty ||= failed;
    } catch (error) {
      failures++;
      status(
        error instanceof Error
          ? error.message.split("\n")[0]!.slice(0, 220)
          : "Things indisponible.",
      );
      dirty = true;
    }
  }

  function blocked(id: string) {
    return state.conflicts.some(
      (c) =>
        c.id === id &&
        (c.field === "item" || c.field.startsWith("match:") || c.field === "browser"),
    );
  }
  async function push(cfg: Config, { before, after }: Patch, remote: Rows, warnings: string[]) {
    const item = (after ?? before)!;
    const uuid = state.links[item.id],
      parent = state.links[item.parent ?? ""];
    if (item.kind === "child") {
      return updateChecklist(cfg, item.parent!, remote, warnings);
    }
    if (!after) {
      if (!uuid || item.kind === "project") return false;
      if (item.kind === "phase" && Object.values(remote).some((r) => r.parent === item.id))
        return false;
      await thingsScript("delete to do id (item 1 of argv)", uuid);
      return true;
    }
    if (!before) return createItem(cfg, item, remote, warnings);
    if (!uuid) return false;
    return updateItem(cfg, item, before, uuid, parent, warnings);
  }
  async function createItem(cfg: Config, item: Entity, remote: Rows, warnings: string[]) {
    const uuid = state.links[item.id],
      parent = state.links[item.parent ?? ""];
    if (item.kind !== "project" && !parent) return false;
    if (uuid) {
      warnings.push("Vérifie le lien Things de « " + item.title + " ».");
      return false;
    }
    if ((item.kind === "project" || item.kind === "phase") && !state.distinct?.includes(item.id)) {
      const matches = Object.values(remote).filter(
        (r) => r.kind === item.kind && r.parent === item.parent && r.title === item.title,
      );
      if (matches.length) {
        for (const match of matches)
          recordConflict(state, item.id, "match:" + match.id, item, match);
        save();
        return false;
      }
    }
    // A persisted unique title lets a restart recover an uncertain create without duplicating it.
    const token = state.pending[item.id] ?? randomUUID();
    if (!state.pending[item.id]) {
      state.pending[item.id] = token;
      save();
    }
    const marker = "Paseo " + token;
    if (item.kind === "phase" && !cfg.headingShortcut) {
      warnings.push("Crée la section « " + item.title + " » dans Things pour la relier.");
      return false;
    }
    if (state.sent?.includes(item.id)) {
      warnings.push("Création à vérifier dans Things · " + item.title);
      return false;
    }
    (state.sent ??= []).push(item.id);
    save();
    await sendNew(cfg, item, marker, parent);
    return true;
  }
  async function sendNew(cfg: Config, item: Entity, marker: string, parent: string | undefined) {
    if (item.kind === "phase") {
      await createThingsHeading(cfg.headingShortcut!, parent!, marker);
      return;
    }
    if (item.kind === "project") {
      // Headings can be created together with a new project using the official URL scheme.
      const phases = Object.values(state.rows).filter(
        (r) => r.kind === "phase" && r.parent === item.id,
      );
      const headings = phases.map((h) => ({ type: "heading", attributes: { title: h.title } }));
      await thingsImport(cfg.binary, [
        { type: "project", attributes: { title: marker, "area-id": cfg.area, items: headings } },
      ]);
    } else {
      const group = state.rows[item.parent ?? ""]!;
      const project = group.kind === "project" ? group : state.rows[group.parent ?? ""]!;
      const attributes: Record<string, unknown> = {
        title: marker,
        "list-id": state.links[project.id],
        notes: item.notes ?? "",
        completed: item.done ?? false,
      };
      if (group.kind === "phase") attributes["heading-id"] = parent;
      const children = Object.values(state.rows).filter(
        (r) => r.kind === "child" && r.parent === item.id,
      );
      attributes["checklist-items"] = children.map((r) => ({
        type: "checklist-item",
        attributes: { title: r.title, completed: r.done ?? false },
      }));
      await thingsImport(cfg.binary, [{ type: "to-do", attributes }]);
    }
  }
  async function updateItem(
    cfg: Config,
    item: Entity,
    before: Entity,
    uuid: string,
    parent: string | undefined,
    warnings: string[],
  ) {
    const changed = fields.filter(
      (field) =>
        before[field] !== item[field] &&
        !state.conflicts.some((c) => c.id === item.id && c.field === field),
    );
    if (!changed.length) return false;
    if (item.kind === "phase") {
      if (changed.includes("title")) {
        await thingsScript(
          "set name of to do id (item 1 of argv) to item 2 of argv",
          uuid,
          item.title,
        );
        return true;
      }
      return false;
    }
    const attrs: Record<string, unknown> = {};
    if (changed.includes("title")) attrs.title = item.title;
    if (changed.includes("notes")) attrs.notes = item.notes ?? "";
    if (changed.includes("done")) attrs.completed = item.done;
    if (changed.includes("parent") && item.kind === "task" && parent) {
      const group = state.rows[item.parent!]!;
      attrs["list-id"] = group.kind === "project" ? parent : state.links[group.parent!];
      if (group.kind === "phase") attrs["heading-id"] = parent;
    }
    if (!Object.keys(attrs).length) return false;
    if (typeof attrs.notes === "string" && attrs.notes.length > 10000) {
      warnings.push("Cette note dépasse la limite de Things.");
      return false;
    }
    await thingsImport(cfg.binary, [
      {
        type: item.kind === "project" ? "project" : "to-do",
        operation: "update",
        id: uuid,
        attributes: attrs,
      },
    ]);
    const check = readThings(filename, cfg.area, state.links).rows[item.id];
    if (!check || changed.some((f) => check[f] !== item[f]))
      throw new Error("Things n’a pas confirmé la modification de « " + item.title + " ».");
    return true;
  }
  let wakeRetry: ReturnType<typeof setTimeout> | undefined;
  function observeWake() {
    // JXA represents JS null as NSNull. Use an Objective-C nil filter and the main queue.
    const observer = `
      ObjC.import("AppKit");
      var center = $.NSWorkspace.sharedWorkspace.notificationCenter;
      var token = center.addObserverForNameObjectQueueUsingBlock(
        $.NSWorkspaceDidWakeNotification, $(), $.NSOperationQueue.mainQueue, () => {
          $.NSFileHandle.fileHandleWithStandardOutput.writeData($("wake").dataUsingEncoding($.NSUTF8StringEncoding));
        }
      );
      $.NSRunLoop.currentRunLoop.run;
    `;
    wake = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", observer], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    wake.stdout?.on("data", () => {
      watcher?.close();
      watcher = undefined;
      schedule(0);
    });
    wake.on("error", () => status("Notification de réveil indisponible."));
    wake.on("close", () => {
      if (!closed) wakeRetry = setTimeout(observeWake, 30000);
    });
  }
  if (config) {
    try {
      db = new DatabaseSync(join(home, "projects-todos.sqlite3"));
      db.exec(
        "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS things_sync (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)",
      );
      const value = db.prepare("SELECT data FROM things_sync WHERE id=1").get()?.data;
      if (typeof value === "string") state = JSON.parse(value) as State;
      else db.prepare("INSERT INTO things_sync VALUES(1,?)").run(JSON.stringify(state));
      observeWake();
      schedule(0);
    } catch {
      config = null;
      db?.close();
      db = undefined;
      status("Synchronisation Things indisponible.");
    }
  }
  return async () => {
    closed = true;
    clearTimeout(timer);
    watcher?.close();
    clearTimeout(wakeRetry);
    wake?.kill();
    signal();
    await worker;
    db?.close();
  };
}
