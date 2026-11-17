import { appendFileSync, statSync, renameSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, rename, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  browserLeaseSchema,
  browserProcessSchema,
  browserRegistrySchema,
  browserOwnerKey,
  reconcileBrowsers,
  type BrowserOwner,
  type BrowserRegistration,
} from "./browser-resource-state.js";
import { BROWSER_RESOURCE_LIMITS, type BrowserResourceLimits } from "./browser-resource-guard.js";
const run = promisify(execFile);

function isBrowserHelperUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}

export async function writeBrowserResourceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export async function runBrowserResourceWorker(
  directory: string,
  binary: string,
  limits: BrowserResourceLimits = BROWSER_RESOURCE_LIMITS,
): Promise<void> {
  function log(message: string): void {
    const path = join(directory, "guard.log");
    try {
      if (statSync(path, { throwIfNoEntry: false })?.size && statSync(path).size > 1024 * 1024)
        renameSync(path, `${path}.previous`);
      appendFileSync(path, message, { mode: 0o600 });
    } catch {
      process.stderr.write("Browser guard could not write its log.\n");
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sampler = spawn(binary, ["watch", join(directory, "guard.lock")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  sampler.on("error", () => {
    process.exitCode = 1;
  });
  let registry: BrowserRegistration[] = [];
  try {
    registry = browserRegistrySchema.parse(
      JSON.parse(await readFile(join(directory, "registry.json"), "utf8")),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      log("Browser guard registry unreadable; rediscovering verified browsers.\n");
  }
  let running = false;
  let unknownPrevious = 0;
  let lastSave = "";
  const output = createInterface({ input: sampler.stdout });
  sampler.on("exit", (code) => {
    output.close();
    process.exitCode = code === 73 ? 0 : (code ?? 1);
  });
  output.on("line", (line) => {
    if (running) return;
    running = true;
    void tick(line)
      .catch((error) => {
        if (isBrowserHelperUnavailable(error)) {
          log("Browser guard helper unavailable; releasing the guard for recovery.\n");
          output.close();
          sampler.kill("SIGTERM");
          process.exitCode = 1;
        } else {
          log("Browser guard sampling failed.\n");
        }
      })
      .finally(() => {
        running = false;
      });
  });
  async function tick(line: string): Promise<void> {
    const processes = z.array(browserProcessSchema).parse(JSON.parse(line));
    const identities = new Set(processes.map((p) => `${p.pid}/${p.startedAt}`));
    const self = processes.find((p) => p.pid === process.pid);
    if (self)
      await writeBrowserResourceJson(join(directory, "status.json"), {
        pid: self.pid,
        startedAt: self.startedAt,
        updatedAt: Date.now(),
      });
    const owners: BrowserOwner[] = [];
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9]{16}\.json$/.test(file)) continue;
      try {
        const lease = browserLeaseSchema.parse(
          JSON.parse(await readFile(join(directory, file), "utf8")),
        );
        const alive = identities.has(`${lease.daemon.pid}/${lease.daemon.startedAt}`);
        const legacyOwners = new Set(lease.owners.map((o) => `${o.namespace}/${o.session}`));
        const markedProcess = processes.some(
          (p) =>
            p.installation === file.slice(0, 16) || legacyOwners.has(`${p.namespace}/${p.session}`),
        );
        if (
          !alive &&
          !markedProcess &&
          !registry.some((r) => r.installation === file.slice(0, 16)) &&
          Date.now() - (await stat(join(directory, file))).mtimeMs > 86400000
        ) {
          await unlink(join(directory, file));
          continue;
        }
        for (const owner of lease.owners) {
          let closed = owner.closed;
          if (!alive && !closed) {
            const owned = registry.filter((r) => browserOwnerKey(r) === browserOwnerKey(owner));
            closed =
              owned.length > 0 &&
              owned.every(
                (r) =>
                  r.ownerProcess === null ||
                  !identities.has(`${r.ownerProcess.pid}/${r.ownerProcess.startedAt}`),
              );
          }
          owners.push({ ...owner, closed });
        }
      } catch {
        log("Browser guard ignored an unreadable owner lease.\n");
      }
    }
    const result = reconcileBrowsers(registry, processes, owners, Date.now(), limits);
    registry = result.registry;
    const serialized = JSON.stringify(registry);
    if (serialized !== lastSave) {
      await writeBrowserResourceJson(join(directory, "registry.json"), registry);
      lastSave = serialized;
    }
    if (result.unknown !== unknownPrevious) {
      log(`Browser guard: ${result.unknown} automation roots without verified ownership.\n`);
      unknownPrevious = result.unknown;
    }
    const stopped = await Promise.all(
      result.stops.map(async (stop) => ({
        stop,
        remaining: await stopSession(stop.registration, binary, log),
      })),
    );
    for (const { stop, remaining } of stopped) {
      const event = {
        installation: stop.registration.installation,
        owner: stop.registration.owner,
        bytes: stop.bytes,
        reason: stop.reason,
        result: remaining === 0 ? "stopped" : "failed",
        remaining,
        timestamp: Date.now(),
        id: `${stop.registration.id}/${Date.now()}`,
      };
      // One bounded mailbox per installation; the daemon acknowledges by event ID.
      const mailbox = join(directory, `${event.installation}.events`);
      let events: unknown[] = [];
      try {
        const value: unknown = JSON.parse(await readFile(mailbox, "utf8"));
        if (Array.isArray(value)) events = value;
      } catch {
        /* First event or corrupt mailbox is replaced. */
      }
      await writeBrowserResourceJson(mailbox, [...events, event].slice(-100));
      log(`${JSON.stringify(event)}\n`);
    }
  }
}

async function stopSession(
  registration: BrowserRegistration,
  binary: string,
  log: (message: string) => void,
): Promise<number> {
  // Children first so the root cannot disappear before its known descendants receive SIGTERM.
  const members = [...registration.members].sort(
    (a, b) => Number(a.pid === registration.root.pid) - Number(b.pid === registration.root.pid),
  );
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (signal === "SIGKILL") {
      await new Promise((resolve) => setTimeout(resolve, BROWSER_RESOURCE_LIMITS.graceMs));
      const processes = z
        .array(browserProcessSchema)
        .parse(JSON.parse((await run(binary, ["snapshot"], { maxBuffer: 16 * 1024 ** 2 })).stdout));
      // Capture children forked during graceful shutdown before escalating.
      const live = reconcileBrowsers([registration], processes, [], Date.now()).registry[0];
      const additions =
        live?.members.filter(
          (p) => !members.some((m) => m.pid === p.pid && m.startedAt === p.startedAt),
        ) ?? [];
      members.push(...additions);
    }
    for (const p of members) {
      try {
        await run(binary, ["signal", String(p.pid), p.startedAt, signal]);
      } catch (error) {
        if (isBrowserHelperUnavailable(error)) throw error;
        if (!(error instanceof Error && "code" in error && error.code === 3))
          log("Browser guard could not signal a verified process.\n");
      }
    }
  }
  const after = z
    .array(browserProcessSchema)
    .parse(JSON.parse((await run(binary, ["snapshot"], { maxBuffer: 16 * 1024 ** 2 })).stdout));
  return members.filter((m) => after.some((p) => p.pid === m.pid && p.startedAt === m.startedAt))
    .length;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1] &&
  process.argv[2] &&
  process.argv[3]
) {
  await runBrowserResourceWorker(process.argv[2], process.argv[3]);
}
