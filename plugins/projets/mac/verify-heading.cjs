// Run with node --import tsx. Supply the installed plugin, Things CLI, shortcut UUID,
// and a disposable Things area containing exactly two empty projects with the same name.
// Add --manual to check the Dev configuration used when Things cannot resolve the UUID.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");

async function verify([plugin, binary, shortcut, area, mode]) {
  assert(
    plugin && binary && shortcut && area,
    "Expected plugin, binary, shortcut UUID and test area",
  );
  assert(mode === undefined || mode === "--manual", "Unknown verification mode");
  // The installed directory can be outside an ESM package. tsx supports require in both layouts.
  const { registerThings } = require(join(resolve(plugin), "server/things-sync.ts"));
  const { thingsCli } = require(join(resolve(plugin), "server/things-db.ts"));
  const db = new DatabaseSync((await thingsCli(binary, ["doctor"])).database, { readOnly: true });
  const home = mkdtempSync(join(tmpdir(), "paseo-heading-test-"));
  const handlers = new Map();
  const running = () => execFileSync("pgrep", ["-x", "Things3"], { encoding: "utf8" }).trim();
  let stop;
  try {
    const projects = db
      .prepare("SELECT uuid, title FROM TMTask WHERE type=1 AND area=? AND trashed=0 ORDER BY uuid")
      .all(area);
    assert.equal(projects.length, 2);
    assert.equal(projects[0].title, projects[1].title);
    const [target, other] = projects.map((p) => p.uuid);
    const sections = db.prepare(
      "SELECT uuid, title FROM TMTask WHERE project=? AND type=2 AND trashed=0",
    );
    assert.deepEqual(sections.all(target), []);
    assert.deepEqual(sections.all(other), []);
    const pid = running();
    const output = join(home, "result");
    execFileSync("shortcuts", ["run", shortcut, "--output-path", output], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
    });
    assert.equal(readFileSync(output, "utf8").trim(), "Crée la phase depuis Paseo");
    assert.equal(running(), pid);
    assert.deepEqual(sections.all(target), []);
    assert.deepEqual(sections.all(other), []);
    writeFileSync(
      join(home, "things-sync.json"),
      JSON.stringify({ binary, area, headingShortcut: mode === "--manual" ? undefined : shortcut }),
    );
    stop = registerThings(
      {
        handle(rpc, action) {
          handlers.set(rpc.name, action);
        },
      },
      home,
    );
    const exchange = handlers.get("things.exchange");
    const parent = "p:things:" + target;
    const id = parent + "/h:1",
      title = "Essai " + randomUUID();
    async function waitFor(predicate, timeout) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (predicate()) return true;
        await delay(150);
      }
      return false;
    }
    assert.ok(
      await waitFor(() => exchange({ edits: [] }).rows.some((row) => row.id === parent), 10000),
      "Project was not imported",
    );
    exchange({ edits: [{ before: null, after: { id, parent, kind: "phase", title } }] });
    if (mode === "--manual") {
      const expected = "Crée la section « " + title + " » dans Things pour la relier.";
      assert.ok(await waitFor(() => exchange({ edits: [] }).message === expected, 10000));
      assert.equal(running(), pid);
      assert.deepEqual(sections.all(target), []);
      assert.deepEqual(sections.all(other), []);
      console.log(expected);
      return;
    }
    const ledger = new DatabaseSync(join(home, "projects-todos.sqlite3"), { readOnly: true });
    try {
      const state = () =>
        JSON.parse(ledger.prepare("SELECT data FROM things_sync WHERE id=1").get().data);
      const confirmed = await waitFor(() => state().base[id]?.title === title, 25000);
      assert.equal(running(), pid, "Things restarted during the test");
      assert.deepEqual(sections.all(other), [], "The other project gained a section");
      const actual = sections.all(target);
      if (!confirmed) {
        assert.deepEqual(actual, [], "Unconfirmed section in Things");
        throw new Error(
          "Aucune section créée dans les deux projets. Garder la création depuis Things.",
        );
      }
      assert.deepEqual(
        actual.map((r) => [r.uuid, r.title]),
        [[state().links[id], title]],
      );
      console.log("Section unique confirmée dans le projet attendu. Things est resté ouvert.");
    } finally {
      ledger.close();
    }
  } finally {
    if (stop) await stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}
verify(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
