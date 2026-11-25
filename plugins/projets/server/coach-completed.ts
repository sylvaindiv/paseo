import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CoachRange } from "../shared/coach.js";
import { dateIn } from "./coach-planning.js";

export function completedTasks({ from, to, timeZone }: CoachRange) {
  try {
    const path =
      process.env.PERSO_THINGS_DATABASE ??
      join(homedir(), "Library/Application Support/Things Local/Library.sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      // Sequence excludes archived tasks. Things encodes completedAt as seconds since 2001.
      const epoch = Date.UTC(2001, 0, 1);
      const rows = db
        .prepare(`
        WITH items_json AS (SELECT CAST(body AS TEXT) AS item FROM items)
        SELECT item ->> '$.id' AS id, item ->> '$.title' AS title,
               item ->> '$.parentID' AS projectId, item ->> '$.completedAt' AS completedAt
        FROM items_json
        WHERE item ->> '$.kind' = 'task' AND item ->> '$.canceled' = 0 AND item ->> '$.trashed' = 0
              AND item ->> '$.completedAt' >= ?
      `)
        .all((Date.parse(from) - epoch) / 1000 - 86400);
      return rows.flatMap(({ id, title, projectId, completedAt }) => {
        if (typeof id !== "string" || typeof title !== "string" || typeof completedAt !== "number")
          return [];
        const date = dateIn(epoch + completedAt * 1000, timeZone);
        return date >= from && date < to
          ? [{ id, title, projectId: typeof projectId === "string" ? projectId : undefined, date }]
          : [];
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
