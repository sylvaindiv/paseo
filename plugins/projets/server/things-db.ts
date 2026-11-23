import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Entity, Rows } from "../shared/things.js";

const exec = promisify(execFile);
export type Links = Record<string, string>;
export function newNumericId() {
  return randomBytes(6).readUIntBE(0, 6);
}

export async function thingsCli(binary: string, args: string[]) {
  const { stdout } = await exec(binary, ["--json", ...args], {
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
export async function thingsScript(body: string, ...args: string[]) {
  const script = 'on run argv\ntell application "Things3"\n' + body + "\nend tell\nend run";
  const { stdout } = await exec("/usr/bin/osascript", ["-e", script, "--", ...args], {
    timeout: 15000,
  });
  return stdout.trim();
}

// All three queries share one read transaction. An unreadable table is never an empty snapshot.
export function readThings(filename: string, area: string, links: Links) {
  const db = new DatabaseSync(filename, { readOnly: true });
  const rows: Rows = {};
  const reverse = new Map(Object.entries(links).map(([key, value]) => [value, key]));
  const assigned: Links = {};
  function localId(uuid: string, kind: Entity["kind"], parent: string | null) {
    const known = reverse.get(uuid);
    if (known) return known;
    let id: string;
    switch (kind) {
      case "project":
        id = "p:things:" + uuid;
        break;
      case "phase":
        id = parent + "/h:" + newNumericId();
        break;
      case "task":
        id = "t:" + newNumericId();
        break;
      case "child":
        id = parent + "/s:" + uuid;
        break;
    }
    reverse.set(uuid, id);
    assigned[id] = uuid;
    return id;
  }
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    if (!db.prepare("SELECT 1 FROM TMArea WHERE uuid=?").get(area))
      throw new Error("Domaine Things introuvable.");
    const projects = db
      .prepare(
        'SELECT uuid,title,notes,status FROM TMTask WHERE area=? AND type=1 AND trashed=0 ORDER BY "index",uuid',
      )
      .all(area);
    const members =
      db.prepare(`SELECT t.uuid,t.title,t.notes,t.status,t.type,t.project,t.heading FROM TMTask t
      WHERE t.trashed=0 AND (t.project=? OR t.heading IN (SELECT uuid FROM TMTask WHERE project=? AND type=2 AND trashed=0))
      AND t.type IN (0,2) ORDER BY t.type DESC,t."index",t.uuid`);
    const children = db.prepare(
      'SELECT uuid,title,status FROM TMChecklistItem WHERE task=? ORDER BY "index",uuid',
    );
    for (const project of projects) {
      const uuid = String(project.uuid),
        id = localId(uuid, "project", null);
      rows[id] = {
        id,
        kind: "project",
        parent: null,
        title: String(project.title ?? ""),
        ...(project.notes ? { notes: String(project.notes) } : {}),
        done: project.status !== 0,
      };
      for (const item of members.all(uuid, uuid)) {
        const kind = item.type === 2 ? "phase" : "task";
        const parent = item.heading ? reverse.get(String(item.heading)) : id;
        if (!parent) throw new Error("Phase Things introuvable.");
        const itemId = localId(String(item.uuid), kind, parent);
        rows[itemId] = {
          id: itemId,
          kind,
          parent,
          title: String(item.title ?? ""),
          ...(kind === "task" ? { notes: String(item.notes ?? ""), done: item.status !== 0 } : {}),
        };
        if (kind === "phase") continue;
        for (const child of children.all(item.uuid!)) {
          const childId = localId(String(child.uuid), "child", itemId);
          rows[childId] = {
            id: childId,
            kind: "child",
            parent: itemId,
            title: String(child.title ?? ""),
            done: child.status !== 0,
          };
        }
      }
    }
    db.exec("COMMIT");
    return { rows, assigned, uuidByKey: { ...links, ...assigned } };
  } finally {
    db.close();
  }
}

export async function thingsImport(binary: string, payload: unknown) {
  const run = exec(binary, ["--json", "import"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  run.child.stdin?.on("error", () => {});
  run.child.stdin?.end(JSON.stringify(payload));
  const { stdout } = await run;
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export async function createThingsHeading(shortcut: string, project: string, title: string) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-things-"));
  try {
    const input = join(directory, "section.json");
    await writeFile(input, JSON.stringify({ project, title }), { mode: 0o600 });
    await exec(
      "/usr/bin/shortcuts",
      ["run", shortcut, "--input-path", input, "--output-path", join(directory, "result")],
      { timeout: 20000 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
