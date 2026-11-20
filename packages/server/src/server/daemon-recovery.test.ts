import { describe, expect, it } from "vitest";
import { DaemonHealthWindow } from "./daemon-recovery-policy.js";

describe("daemon recovery evidence", () => {
  it("requires observed failures over twenty seconds", () => {
    const health = new DaemonHealthWindow();
    expect([0, 5000, 10000, 15000, 20000].map((t) => health.observe(t, false))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
  it("discards failures across sleep and after a healthy reply", () => {
    const health = new DaemonHealthWindow();
    for (const t of [1000, 6000, 11000, 16000]) expect(health.observe(t, false)).toBe(false);
    expect(health.observe(100000, false)).toBe(false);
    expect(health.observe(105000, true)).toBe(false);
    expect(health.observe(110000, false)).toBe(false);
  });
  it("preserves the budget until ten minutes of observed health", () => {
    const health = new DaemonHealthWindow();
    health.attempts = 3;
    for (let t = 1000; t <= 601000; t += 5000) health.observe(t, true);
    expect(health.attempts).toBe(0);
    health.attempts = 2;
    health.resetObservations();
    expect(health.attempts).toBe(2);
  });
});

import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { savePersistedConfig } from "./persisted-config.js";
import {
  collectGenerationProcesses,
  ensureDaemonCoordinator,
  startCoordinatedDaemon,
  managedDaemonCommand,
} from "./daemon-recovery.js";
import {
  readDaemonRecovery,
  requestDaemonRecovery,
  recoverySocket,
  publicRecoveryState,
  type RecoveryState,
} from "./daemon-recovery-client.js";
import { getPidLockInfo } from "./pid-lock.js";
import { withLocalDaemon } from "./daemon-recovery-health.js";

it("reads a failed coordinator state without confusing its diagnostic with an RPC error", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-rc-"));
  const state = {
    generation: randomUUID(),
    desired: true,
    monitoring: true,
    attempts: 3,
    status: "failed",
    error: "Automatic recovery budget exhausted",
    processes: [],
  };
  const server = createServer((socket) =>
    socket.once("data", () => socket.end(`${JSON.stringify(state)}\n`)),
  );
  try {
    await new Promise<void>((resolve) => server.listen(recoverySocket(home), resolve));
    await expect(requestDaemonRecovery(home, "status")).resolves.toEqual(state);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

it("compacts a 15,776-entry registry using current identities", async () => {
  const state: RecoveryState = {
    generation: randomUUID(),
    desired: true,
    monitoring: true,
    status: "failed",
    attempts: 2,
    error: "🛠".repeat(5000),
    processes: Array.from({ length: 15_776 }, (_, index) => ({
      pid: index + 2,
      startedAt: "1:1",
      uid: 501,
      executable:
        "/Applications/Paseo Local.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
      generation: "",
      parent: 1,
    })),
  };
  const observation = {
    parent: 1,
    startedAt: "1:1",
    uid: 501,
    executable: "/bin/sleep",
    generation: "",
  };
  expect(
    collectGenerationProcesses(
      [
        { ...observation, pid: 3 },
        { ...observation, pid: 4, startedAt: "2:2" },
        { ...observation, pid: 5, shared: "1", generation: state.generation },
        { ...observation, pid: 20_000, parent: 3 },
        { ...observation, pid: 20_001, parent: 4 },
      ],
      state,
    ).map((p) => p.pid),
  ).toEqual([3, 20_000]);

  const home = await mkdtemp(join(tmpdir(), "paseo-rc-"));
  const wire = JSON.stringify(state);
  expect(Buffer.byteLength(wire)).toBeGreaterThan(2.5 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(publicRecoveryState(state)))).toBeLessThan(16 * 1024);
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(`${wire}\n`));
  });
  try {
    await new Promise<void>((resolve) => server.listen(recoverySocket(home), resolve));
    await expect(requestDaemonRecovery(home, "status")).rejects.toMatchObject({
      code: "RECOVERY_RESPONSE_TOO_LARGE",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")(
  "takes over once, adopts a healthy daemon and preserves stop intent",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-rc-"));
    const marker = join(home, "runtime.mjs");
    const manifest = join(home, "daemon-recovery-launch.json");
    const helper = resolvePath("packages/server/dist/server/server/paseo-browser-resource");
    const entry = resolvePath("packages/server/dist/scripts/supervisor-entrypoint.js");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
    );
    const launch = {
      home,
      command: process.execPath,
      args: ["--import", marker, entry],
      env: { ...env, HOME: home, PASEO_HOME: home },
    };
    const terminateCoordinator = async () => {
      const state = await readDaemonRecovery(home);
      if (state?.coordinator)
        execFileSync(helper, [
          "signal",
          String(state.coordinator.pid),
          state.coordinator.startedAt,
          "SIGTERM",
        ]);
    };
    try {
      await writeFile(marker, "export {};\n");
      savePersistedConfig(home, {
        daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
        features: {
          webUi: { enabled: false },
          dictation: { enabled: false },
          voiceMode: { enabled: false },
        },
      });
      const initial = await startCoordinatedDaemon(launch);
      const first = (await readDaemonRecovery(home))!;
      await unlink(manifest);
      await Promise.all([1, 2, 3].map(() => ensureDaemonCoordinator(home, launch)));
      const adopted = (await readDaemonRecovery(home))!;
      expect(adopted.coordinator?.pid).not.toBe(first.coordinator?.pid);
      expect((await managedDaemonCommand(home, "recover", launch)).generation).toBe(
        first.generation,
      );
      expect((await getPidLockInfo(home))?.pid).toBe(initial.instance.pid);
      await writeFile(marker, "export const updated = true;\n");
      await expect(managedDaemonCommand(home, "restart")).rejects.toThrow("runtime changed");
      const restarted = await managedDaemonCommand(home, "restart", launch);
      expect(restarted.generation).not.toBe(first.generation);
      expect(restarted.lastStop).toMatchObject({ forced: false, usedLifecycleRpc: true });
      await managedDaemonCommand(home, "stop", launch);
      await terminateCoordinator();
      await unlink(manifest);
      await managedDaemonCommand(home, "recover", launch, true);
      expect(await getPidLockInfo(home)).toBeNull();
      expect((await readDaemonRecovery(home))?.desired).toBe(false);
    } finally {
      await managedDaemonCommand(home, "stop_force", launch).catch(() => {});
      await terminateCoordinator().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  },
  180_000,
);

async function injectDaemonFailure(
  failure: string,
  home: string,
  supervisorPid: number,
  workerPid: number,
): Promise<void> {
  if (failure === "worker-stop") {
    const sameGeneration = (await readDaemonRecovery(home))!.generation;
    process.kill(workerPid, "SIGSTOP");
    const observationDeadline = Date.now() + 40_000;
    while (
      (await readDaemonRecovery(home))?.status !== "recovering" &&
      Date.now() < observationDeadline
    )
      await delay(100);
    expect((await readDaemonRecovery(home))?.status).toBe("recovering");
    process.kill(workerPid, "SIGCONT");
    const resumeDeadline = Date.now() + 10_000;
    while ((await readDaemonRecovery(home))?.status !== "healthy" && Date.now() < resumeDeadline)
      await delay(100);
    expect((await readDaemonRecovery(home))?.status).toBe("healthy");
    expect((await readDaemonRecovery(home))?.generation).toBe(sameGeneration);
  }
  if (failure === "orphan-worker") {
    expect((await readDaemonRecovery(home))!.processes.some((p) => p.pid === workerPid)).toBe(true);
    process.kill(workerPid, "SIGSTOP");
    process.kill(supervisorPid, "SIGKILL");
  } else if (failure === "coordinator-stop") {
    const stoppedCoordinator = (await readDaemonRecovery(home))!;
    process.kill(stoppedCoordinator.coordinator!.pid, "SIGSTOP");
    await writeFile(
      join(home, "daemon-recovery.json"),
      JSON.stringify({ ...stoppedCoordinator, attempts: 3 }),
    );
    process.kill(workerPid, "SIGSTOP");
    await managedDaemonCommand(home, "recover");
  } else {
    process.kill(
      failure === "worker-stop" ? workerPid : supervisorPid,
      failure === "supervisor-exit" ? "SIGKILL" : "SIGSTOP",
    );
  }
}

it
  .skipIf(process.platform !== "darwin")
  .each([
    "worker-stop",
    "supervisor-stop",
    "supervisor-exit",
    "coordinator-stop",
    "orphan-worker",
  ] as const)(
  "recovers %s independently of the launching client and respects stop",
  async (failure) => {
    const home = await mkdtemp(join(tmpdir(), "paseo-recovery-"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
    );
    let supervisorPid: number | undefined;
    try {
      savePersistedConfig(home, {
        daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
        features: {
          webUi: { enabled: false },
          dictation: { enabled: false },
          voiceMode: { enabled: false },
        },
      });
      const initial = await startCoordinatedDaemon({
        home,
        command: process.execPath,
        args: [resolvePath("packages/server/dist/scripts/supervisor-entrypoint.js")],
        env: { ...env, HOME: home, PASEO_HOME: home, PASEO_DESKTOP_MANAGED: "1" },
      });
      supervisorPid = initial.instance.pid;
      const originalConfig = await readFile(join(home, "config.json"), "utf8");
      const serverIdentity = await readFile(join(home, "server-id"), "utf8");
      const status = await withLocalDaemon(home, initial.instance.listen!, (c) =>
        c.getDaemonStatus({ timeout: 5000 }),
      );
      await injectDaemonFailure(failure, home, initial.instance.pid, status.pid);
      const deadline = Date.now() + 110_000;
      let replacement = initial.instance;
      while (Date.now() < deadline) {
        await delay(1000);
        const current = await getPidLockInfo(home);
        if (
          current?.listen &&
          current.pid !== initial.instance.pid &&
          (await readDaemonRecovery(home))?.status === "healthy"
        ) {
          replacement = current;
          break;
        }
      }
      expect(replacement.pid).not.toBe(initial.instance.pid);
      supervisorPid = replacement.pid;
      await withLocalDaemon(home, replacement.listen!, (c) => c.ping({ timeoutMs: 2000 }));
      expect(await readFile(join(home, "config.json"), "utf8")).toBe(originalConfig);
      expect(await readFile(join(home, "server-id"), "utf8")).toBe(serverIdentity);
      if (failure === "worker-stop") {
        const previous = (await readDaemonRecovery(home))!.generation;
        const simultaneous = await Promise.all(
          [1, 2, 3].map(() => requestDaemonRecovery(home, "restart")),
        );
        expect(new Set(simultaneous.map((s) => s.generation)).size).toBe(1);
        expect(simultaneous[0].generation).not.toBe(previous);
        await requestDaemonRecovery(home, "disable");
        expect((await readDaemonRecovery(home))?.monitoring).toBe(false);
        await expect(requestDaemonRecovery(home, "recover")).rejects.toThrow("disabled");
        await requestDaemonRecovery(home, "start");
      }
      if (failure === "coordinator-stop") {
        expect((await readDaemonRecovery(home))?.attempts).toBe(0);
        const pendingRestart = requestDaemonRecovery(home, "restart").then(
          () => "completed",
          () => "cancelled",
        );
        const pendingDeadline = Date.now() + 10_000;
        while (
          (await readDaemonRecovery(home))?.status !== "recovering" &&
          Date.now() < pendingDeadline
        )
          await delay(25);
        await requestDaemonRecovery(home, "stop");
        await pendingRestart;
      }
      await managedDaemonCommand(home, "stop");
      expect((await readDaemonRecovery(home))?.desired).toBe(false);
      expect(await getPidLockInfo(home)).toBe(null);
      await delay(6000);
      expect(await getPidLockInfo(home)).toBe(null);
    } finally {
      if (supervisorPid) {
        try {
          process.kill(supervisorPid, "SIGCONT");
        } catch {}
      }
      await requestDaemonRecovery(home, "stop_force").catch(() => {});
      // Disable leaves no restart intent; the detached observer is terminated by its recorded parent PID.
      const state = await readDaemonRecovery(home).catch(() => null);
      if (state?.coordinator) {
        execFileSync(resolvePath("packages/server/dist/server/server/paseo-browser-resource"), [
          "signal",
          String(state.coordinator.pid),
          state.coordinator.startedAt,
          "SIGTERM",
        ]);
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  300_000,
);
