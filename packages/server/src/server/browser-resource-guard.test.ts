import { describe, expect, it } from "vitest";
import {
  selectBrowserResourceStops,
  stopBrowserProcesses,
  type BrowserResourceSession,
} from "./browser-resource-guard.js";

const GiB = 1024 ** 3;
const session = (id: string, gib: number): BrowserResourceSession => ({
  id,
  bytes: gib * GiB,
  ownerClosed: false,
  ownerLastActiveAt: 0,
});

describe("browser resource policy", () => {
  it("enforces individual limits even with an active owner", () => {
    expect(selectBrowserResourceStops([session("a", 2.01), session("b", 2)], 0)).toEqual([
      { id: "a", reason: "memory" },
    ]);
  });
  it("stops largest sessions until below the recovery budget", () => {
    expect(
      selectBrowserResourceStops([session("a", 2), session("b", 1.5), session("c", 1.5)], 0),
    ).toEqual([
      { id: "a", reason: "memory" },
      { id: "b", reason: "memory" },
    ]);
  });
  it("recovers below three GiB when individual stops leave the shared budget above recovery", () => {
    expect(
      selectBrowserResourceStops([session("a", 2.1), session("b", 2), session("c", 1.9)], 0),
    ).toEqual([
      { id: "a", reason: "memory" },
      { id: "b", reason: "memory" },
    ]);
  });
  it("does not trigger recovery below the global threshold", () => {
    expect(selectBrowserResourceStops([session("a", 2), session("b", 2)], 0)).toEqual([]);
  });
  it("cleans up closed and inactive owners without counting their memory twice", () => {
    expect(
      selectBrowserResourceStops(
        [{ ...session("a", 2), ownerClosed: true }, session("b", 2)],
        300_000,
      ),
    ).toEqual([
      { id: "a", reason: "owner_closed" },
      { id: "b", reason: "owner_idle" },
    ]);
  });
  it("rejects duplicated sessions and invalid measurements", () => {
    expect(() => selectBrowserResourceStops([session("a", 1), session("a", 1)], 0)).toThrow();
    expect(() => selectBrowserResourceStops([session("a", Number.NaN)], 0)).toThrow();
  });
  it("does not mutate the shared sample", () => {
    const sessions = [session("a", 1.5), session("b", 2), session("c", 1.5)];
    selectBrowserResourceStops(sessions, 0);
    expect(sessions.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });
});

describe("identity checked browser shutdown", () => {
  it("escalates resistant processes but preserves reused PIDs and detached unknown processes", async () => {
    const identities = new Map([
      [10, "original"],
      [11, "original"],
    ]);
    const signals: unknown[] = [];
    await stopBrowserProcesses(
      [10, 11, 12].map((pid) => ({ pid, startedAt: "original" })),
      {
        identify: async (pid) => {
          const startedAt = identities.get(pid);
          return startedAt ? { pid, startedAt } : null;
        },
        signal: async (pid, signal) => {
          signals.push([pid, signal]);
        },
        wait: async (ms) => {
          expect(ms).toBe(1000);
          identities.set(11, "replacement");
        },
      },
    );
    expect(signals).toEqual([
      [10, "SIGTERM"],
      [11, "SIGTERM"],
      [10, "SIGKILL"],
    ]);
  });
});

// The same kernel identities are used by the native sampler and the persisted registry.
import {
  reconcileBrowsers,
  type BrowserProcess,
  type BrowserOwner,
} from "./browser-resource-state.js";
const owner: BrowserOwner = {
  installation: "0123456789abcdef",
  owner: "agent:test",
  namespace: "p-0123456789abcdef",
  session: "a-0123456789ab",
  closed: false,
  lastActiveAt: 0,
};
function sampled(pid: number, parent: number, browser = false): BrowserProcess {
  return {
    pid,
    parent,
    startedAt: `${pid}:1`,
    bytes: 1024,
    measured: true,
    browser,
    installation: "",
    owner: "",
    namespace: "",
    session: "",
  };
}
function owned(pid: number, parent: number, browser = false): BrowserProcess {
  return { ...sampled(pid, parent, browser), installation: owner.installation, owner: owner.owner };
}
describe("browser attribution and recovery", () => {
  it("never adopts personal Chrome, a preexisting CDP connection or an embedded browser", () => {
    const personal = sampled(10, 1, true);
    const embedded = owned(11, 20);
    const connector = owned(20, 1);
    const result = reconcileBrowsers([], [personal, embedded, connector], [owner], 0);
    expect(result).toEqual({ registry: [], stops: [], unknown: 1 });
  });
  it("adopts a marked automation root and counts its descendants once", () => {
    const result = reconcileBrowsers(
      [],
      [sampled(12, 11), owned(10, 1), owned(11, 10, true)],
      [owner],
      0,
    );
    expect(result.registry).toHaveLength(1);
    expect(result.registry[0]!.members.map((p) => p.pid).sort()).toEqual([11, 12]);
    expect(result.registry[0]!.ownerProcess).toEqual({ pid: 10, startedAt: "10:1" });
  });
  it("retains detached descendants across restart and forgets reused PIDs", () => {
    const initial = reconcileBrowsers(
      [],
      [owned(10, 1), owned(11, 10, true), sampled(12, 11)],
      [owner],
      0,
    );
    const restored = JSON.parse(JSON.stringify(initial.registry));
    const next = reconcileBrowsers(
      restored,
      [sampled(12, 1), { ...sampled(11, 1, true), startedAt: "99:1" }],
      [owner],
      0,
    );
    expect(next.registry[0]!.members).toEqual([{ pid: 12, startedAt: "12:1" }]);
    expect(next.unknown).toBe(1);
  });
  it("recovers legacy sessions only through a verified namespace and owner session", () => {
    const legacy = { ...sampled(11, 1, true), namespace: owner.namespace, session: owner.session };
    expect(reconcileBrowsers([], [legacy], [owner], 0).registry).toHaveLength(1);
    expect(reconcileBrowsers([], [{ ...legacy, session: "a-other" }], [owner], 0).registry).toEqual(
      [],
    );
  });
  it("keeps the nearest owner when an agent was launched by another agent", () => {
    const parent = { ...owner, owner: "agent:parent" };
    const result = reconcileBrowsers(
      [],
      [{ ...owned(9, 1), owner: parent.owner }, owned(10, 9), owned(11, 10, true)],
      [owner, parent],
      0,
    );
    expect(result.registry[0]!.owner).toBe(owner.owner);
    expect(result.registry[0]!.ownerProcess).toEqual({ pid: 10, startedAt: "10:1" });
  });
  it("bounds the registry over twenty open/close cycles", () => {
    let registry = reconcileBrowsers([], [], [owner], 0).registry;
    for (let i = 0; i < 20; i++) {
      registry = reconcileBrowsers(registry, [owned(11 + i, 1, true)], [owner], 0).registry;
      expect(registry).toHaveLength(1);
      registry = reconcileBrowsers(registry, [], [owner], 0).registry;
      expect(registry).toEqual([]);
    }
  });
});

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { beforeAll, afterAll } from "vitest";
import { browserProcessSchema } from "./browser-resource-state.js";
import { z } from "zod";
const execute = promisify(execFile);

describe.skipIf(process.platform !== "darwin")(
  "macOS browser guard with real isolated processes",
  () => {
    let directory: string;
    let binary: string;
    let chrome: string;
    const children: ChildProcess[] = [];
    const child = (command: string, args: string[], env = process.env) => {
      const result = spawn(command, args, { env, stdio: "ignore" });
      children.push(result);
      return result;
    };
    async function snapshot() {
      return z
        .array(browserProcessSchema)
        .parse(
          JSON.parse((await execute(binary, ["snapshot"], { maxBuffer: 16 * 1024 ** 2 })).stdout),
        );
    }
    async function processPresent(pid: number | undefined, minimumBytes = 0): Promise<boolean> {
      return (await snapshot()).some((p) => p.pid === pid && p.bytes >= minimumBytes);
    }
    async function waitUntil(check: () => Promise<boolean>) {
      const deadline = Date.now() + 7000;
      while (!(await check())) {
        if (Date.now() >= deadline)
          throw new Error("Isolated browser guard did not reach the expected state");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "paseo-browser-guard-test-"));
      binary = join(directory, "paseo-browser-resource");
      chrome = join(directory, "chrome");
      await execute("xcrun", [
        "clang",
        "-O2",
        "-Wall",
        "-Werror",
        fileURLToPath(new URL("../../native/browser-resource/main.c", import.meta.url)),
        "-lproc",
        "-o",
        binary,
      ]);
      await execute("xcrun", [
        "clang",
        "-O0",
        fileURLToPath(new URL("./test-utils/browser-resource-fixture.c", import.meta.url)),
        "-o",
        chrome,
      ]);
    });
    afterAll(async () => {
      for (const process of children) if (process.exitCode === null) process.kill("SIGKILL");
      await Promise.all(
        children
          .filter((p) => p.exitCode === null && p.signalCode === null)
          .map((p) => once(p, "exit")),
      );
      await rm(directory, { recursive: true, force: true });
    });
    it("uses one native watcher per user directory", async () => {
      const first = spawn(binary, ["watch", join(directory, "watch.lock")], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(first);
      await once(first.stdout!, "data");
      const second = child(binary, ["watch", join(directory, "watch.lock")]);
      const [code] = await once(second, "exit");
      expect(code).toBe(73);
      first.kill("SIGKILL");
      await once(first, "exit");
    });
    it("measures footprint, rejects a reused identity and stops a resistant browser under five seconds", async () => {
      const root = join(directory, "worker");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(root);
      const args = ["--remote-debugging-pipe", `--user-data-dir=${directory}/isolated-profile`];
      const markedEnv = {
        ...process.env,
        PASEO_BROWSER_INSTALLATION: owner.installation,
        PASEO_BROWSER_OWNER: owner.owner,
      };
      const browser = child(chrome, args, markedEnv);
      // A browser connected later to CDP has no inherited ownership; an Electron host never qualifies.
      const personal = child(chrome, args);
      const embeddedPath = join(directory, "Paseo");
      await copyFile(chrome, embeddedPath);
      const embedded = child(embeddedPath, args, markedEnv);
      await waitUntil(() => processPresent(browser.pid, 8 * 1024 ** 2));
      const initial = await snapshot();
      const browserIdentity = initial.find((p) => p.pid === browser.pid)!;
      const daemon = initial.find((p) => p.pid === process.pid)!;
      expect(browserIdentity.browser).toBe(true);
      expect(initial.find((p) => p.pid === embedded.pid)!.browser).toBe(false);
      await expect(
        execute(binary, ["signal", String(browser.pid), "0:0", "SIGKILL"]),
      ).rejects.toMatchObject({ code: 3 });
      expect(browser.exitCode).toBeNull();
      await writeFile(
        join(root, `${owner.installation}.json`),
        JSON.stringify({ daemon, owners: [{ ...owner, lastActiveAt: Date.now() }] }),
      );
      const runner = join(directory, "worker-runner.mjs");
      const workerModule = new URL("./browser-resource-worker.ts", import.meta.url).href;
      await writeFile(
        runner,
        `import { runBrowserResourceWorker } from ${JSON.stringify(workerModule)}; await runBrowserResourceWorker(process.argv[2], process.argv[3], { sessionBytes: 8388608, totalBytes: 16777216, recoveryBytes: 12582912, idleMs: 300000, intervalMs: 2000, graceMs: 1000 });`,
      );
      const started = Date.now();
      const worker = child(process.execPath, [
        "--import",
        import.meta.resolve("tsx"),
        runner,
        root,
        binary,
      ]);
      await once(browser, "exit");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(browser.signalCode).toBe("SIGKILL");
      expect(personal.exitCode).toBeNull();
      expect(personal.signalCode).toBeNull();
      expect(embedded.exitCode).toBeNull();
      expect(embedded.signalCode).toBeNull();
      await waitUntil(async () => {
        try {
          return JSON.parse(await readFile(join(root, "registry.json"), "utf8")).length === 0;
        } catch {
          return false;
        }
      });
      const events = JSON.parse(await readFile(join(root, `${owner.installation}.events`), "utf8"));
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe("memory");
      worker.kill("SIGKILL");
      await once(worker, "exit");
      // The sampler exits when this worker disappears, releasing the kernel lock.
      await new Promise((resolve) => setTimeout(resolve, 2100));
    }, 15000);
    it("recovers the registry after worker loss and cleans up after the owner and daemon disappear", async () => {
      const root = join(directory, "restart");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(root);
      const env = {
        ...process.env,
        PASEO_BROWSER_INSTALLATION: owner.installation,
        PASEO_BROWSER_OWNER: owner.owner,
      };
      const providerScript = join(directory, "provider.cjs");
      const browserPidPath = join(directory, "browser-pid");
      await writeFile(
        providerScript,
        `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.argv[2],['--remote-debugging-pipe','--user-data-dir=/tmp/paseo-test-profile'],{stdio:'ignore'});writeFileSync(process.argv[3],String(child.pid));setInterval(()=>{},1000);`,
      );
      const provider = child(process.execPath, [providerScript, chrome, browserPidPath], env);
      const daemonProcess = child("/bin/sleep", ["60"]);
      await waitUntil(async () => {
        try {
          await readFile(browserPidPath);
          return true;
        } catch {
          return false;
        }
      });
      const browserPid = Number(await readFile(browserPidPath, "utf8"));
      const daemon = (await snapshot()).find((p) => p.pid === daemonProcess.pid)!;
      await writeFile(
        join(root, `${owner.installation}.json`),
        JSON.stringify({ daemon, owners: [{ ...owner, lastActiveAt: Date.now() }] }),
      );
      const workerPath = fileURLToPath(new URL("./browser-resource-worker.ts", import.meta.url));
      const entry = fileURLToPath(new URL("./browser-resource-entry.cjs", import.meta.url));
      const args = ["--import", import.meta.resolve("tsx"), entry, workerPath, root, binary];
      const first = child(process.execPath, args);
      await waitUntil(async () => {
        try {
          return JSON.parse(await readFile(join(root, "registry.json"), "utf8")).length === 1;
        } catch {
          return false;
        }
      });
      const persisted = JSON.parse(await readFile(join(root, "registry.json"), "utf8"));
      expect(persisted[0].ownerProcess.pid).toBe(provider.pid);
      const sampler = (await snapshot()).find((p) => p.parent === first.pid)!;
      first.kill("SIGKILL");
      await once(first, "exit");
      await waitUntil(async () => !(await processPresent(sampler.pid)));
      expect((await snapshot()).some((p) => p.pid === browserPid)).toBe(true);
      provider.kill("SIGKILL");
      daemonProcess.kill("SIGKILL");
      await Promise.all([once(provider, "exit"), once(daemonProcess, "exit")]);
      const second = child(process.execPath, args);
      await waitUntil(async () => !(await processPresent(browserPid)));
      await waitUntil(
        async () => JSON.parse(await readFile(join(root, "registry.json"), "utf8")).length === 0,
      );
      const events = JSON.parse(await readFile(join(root, `${owner.installation}.events`), "utf8"));
      expect(events[0].reason).toBe("owner_closed");
      const secondSampler = (await snapshot()).find((p) => p.parent === second.pid)!;
      second.kill("SIGKILL");
      await once(second, "exit");
      await waitUntil(async () => !(await processPresent(secondSampler.pid)));
    }, 20000);
    it("releases the guard when its helper disappears so another installation can recover", async () => {
      const root = join(directory, "removed-helper");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(root);
      const temporaryBinary = join(root, "paseo-browser-resource");
      await copyFile(binary, temporaryBinary);
      const browser = child(
        chrome,
        ["--remote-debugging-pipe", `--user-data-dir=${root}/profile`],
        {
          ...process.env,
          PASEO_BROWSER_INSTALLATION: owner.installation,
          PASEO_BROWSER_OWNER: owner.owner,
        },
      );
      const daemon = (await snapshot()).find((p) => p.pid === process.pid)!;
      const leasePath = join(root, `${owner.installation}.json`);
      const lease = { daemon, owners: [{ ...owner, lastActiveAt: Date.now() }] };
      await writeFile(leasePath, JSON.stringify(lease));
      const workerPath = fileURLToPath(new URL("./browser-resource-worker.ts", import.meta.url));
      const args = ["--import", import.meta.resolve("tsx"), workerPath, root];
      const first = child(process.execPath, [...args, temporaryBinary]);
      await waitUntil(async () => {
        try {
          return JSON.parse(await readFile(join(root, "registry.json"), "utf8")).length === 1;
        } catch {
          return false;
        }
      });
      await rm(temporaryBinary);
      lease.owners[0]!.closed = true;
      await writeFile(leasePath, JSON.stringify(lease));
      await waitUntil(async () => first.exitCode !== null);
      expect(first.exitCode).toBe(1);

      const second = child(process.execPath, [...args, binary]);
      await waitUntil(async () => !(await processPresent(browser.pid)));
      await waitUntil(async () => {
        try {
          const events = JSON.parse(
            await readFile(join(root, `${owner.installation}.events`), "utf8"),
          );
          return events[0]?.result === "stopped";
        } catch {
          return false;
        }
      });
      const sampler = (await snapshot()).find((p) => p.parent === second.pid)!;
      second.kill("SIGKILL");
      await once(second, "exit");
      await waitUntil(async () => !(await processPresent(sampler.pid)));
    }, 20000);
  },
);
