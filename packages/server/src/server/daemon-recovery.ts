import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, access, unlink, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createStream } from "rotating-file-stream";
import { z } from "zod";
import { nativeProcessSnapshot, signalNativeProcess } from "./native-process.js";
import { ensurePrivateDirectory } from "./private-files.js";
import {
  isPidLockOwnerRunning,
  getPidLockInfo,
  isSamePidLock,
  releasePidLock,
  type PidLockInfo,
} from "./pid-lock.js";
import { daemonLaunchEnvironment } from "./config-environment.js";
import { DAEMON_RECOVERY as limits, DaemonHealthWindow } from "./daemon-recovery-policy.js";
import {
  readDaemonRecovery,
  requestDaemonRecovery,
  recoverySocket,
  writeRecoveryJson,
  type RecoveryState,
  type RecoveryCommand,
} from "./daemon-recovery-client.js";
import { withLocalDaemon } from "./daemon-recovery-health.js";
const execute = promisify(execFile);
const processSchema = z.object({
  pid: z.number(),
  parent: z.number(),
  startedAt: z.string(),
  generation: z.string(),
  shared: z.string().optional(),
  uid: z.number(),
  executable: z.string(),
});
type NativeProcess = z.infer<typeof processSchema>;
const launchSchema = z.object({
  command: z.string().refine(isAbsolute),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string().optional()),
  fingerprint: z.string(),
});
type Launch = z.infer<typeof launchSchema>;
const helperPath = () => {
  const candidates = [
    "./paseo-browser-resource",
    "../../server/server/paseo-browser-resource",
    "../../dist/server/server/paseo-browser-resource",
  ];
  for (const candidate of candidates) {
    const file = fileURLToPath(new URL(candidate, import.meta.url)).replace(
      /\.asar\//,
      ".asar.unpacked/",
    );
    if (existsSync(file)) return file;
  }
  throw new Error("Bundled native process helper unavailable");
};

function collectGenerationProcesses(
  snapshot: NativeProcess[],
  state: RecoveryState,
  rootPid?: number,
): RecoveryState["processes"] {
  const known = new Map(state.processes.map((p) => [`${p.pid}:${p.startedAt}`, p]));
  const owned = new Set(
    state.processes
      .filter((p) => snapshot.some((s) => s.pid === p.pid && s.startedAt === p.startedAt))
      .map((p) => p.pid),
  );
  if (rootPid) owned.add(rootPid);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of snapshot)
      if (
        p.shared !== "1" &&
        (p.generation === state.generation || owned.has(p.pid) || owned.has(p.parent)) &&
        !known.has(`${p.pid}:${p.startedAt}`)
      ) {
        known.set(`${p.pid}:${p.startedAt}`, p);
        owned.add(p.pid);
        changed = true;
      }
  }
  return [...known.values()];
}

function captureRecoveryRoot(
  instance: PidLockInfo | null,
  snapshot: NativeProcess[],
  state: RecoveryState,
): void {
  if (instance && instance.uid !== (process.getuid?.() ?? 0))
    throw new Error("Daemon owner changed; refusing cleanup");
  const root = instance ? snapshot.find((p) => p.pid === instance.pid) : undefined;
  if (instance?.generation && instance.generation !== state.generation)
    throw new Error("Daemon generation changed; refusing cleanup");
  if (root && instance) {
    const captured = state.processes.some(
      (p) => p.pid === root.pid && p.startedAt === root.startedAt,
    );
    const published =
      instance.generation === state.generation && instance.nativeStartedAt === root.startedAt;
    if (!captured && !published) throw new Error("Daemon identity is unproven; refusing cleanup");
    state.processes = collectGenerationProcesses(snapshot, state, root.pid);
  }
}

async function requestRecoveryShutdown(
  home: string,
  listen: string,
  force: boolean,
): Promise<boolean> {
  try {
    await withLocalDaemon(home, listen, (c) => c.shutdownServer({ timeout: limits.shutdownMs }));
    return true;
  } catch (error) {
    const code = String((error as { code?: string }).code);
    if (
      !force ||
      !["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT", "DAEMON_UNREACHABLE"].includes(code)
    )
      throw error;
    return false;
  }
}

async function fingerprint(command: string, args: string[]): Promise<string> {
  const hash = createHash("sha256");
  const files = new Set([command, ...args.filter((a) => existsSync(a)), helperPath()]);
  for (const relative of [
    "./daemon-worker.js",
    "../../server/server/daemon-worker.js",
    "../../scripts/supervisor.js",
    "../../scripts/supervisor-entrypoint.js",
  ]) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(file)) files.add(file);
  }
  let packageRoot = dirname(fileURLToPath(import.meta.url));
  while (dirname(packageRoot) !== packageRoot) {
    const manifest = join(packageRoot, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(await readFile(manifest, "utf8")).name === "@getpaseo/server"
    )
      break;
    packageRoot = dirname(packageRoot);
  }
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (/\.(?:js|cjs|mjs)$/.test(file)) files.add(file);
    }
  };
  for (const directory of [join(packageRoot, "dist"), join(packageRoot, "../cli/dist")]) {
    if (existsSync(directory)) await collect(directory);
  }
  for (const file of [...files].sort()) hash.update(file).update(await readFile(file));
  return hash.digest("hex");
}

async function replaceUnresponsiveCoordinator(home: string): Promise<void> {
  const state = await readDaemonRecovery(home);
  const saved = launchSchema.parse(
    JSON.parse(await readFile(join(home, "daemon-recovery-launch.json"), "utf8")),
  );
  if ((await fingerprint(saved.command, saved.args)) !== saved.fingerprint)
    throw new Error("Bundled recovery runtime changed; preserving the coordinator");
  const expected = state?.coordinator;
  const actual = (await nativeProcessSnapshot()).find((p) => p.pid === expected?.pid);
  if (!expected) throw new Error("Coordinator native identity is unproven");
  if (actual?.startedAt === expected.startedAt) {
    if (actual.executable !== (await realpath(saved.command)))
      throw new Error("Coordinator executable changed; preserving it");
    await signalNativeProcess(actual, "SIGKILL").catch((signalError) => {
      if (signalError.code !== 3) throw signalError;
    });
  }
  await delay(2500);
}

export async function ensureDaemonCoordinator(
  home: string,
  launch?: { command: string; args: string[]; env: NodeJS.ProcessEnv },
  recoverUnresponsive = false,
): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Managed recovery requires macOS");
  try {
    await requestDaemonRecovery(home, "status");
    return;
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (code === "RECOVERY_COORDINATOR_TIMEOUT" && recoverUnresponsive) {
      await replaceUnresponsiveCoordinator(home);
    } else if (!["ENOENT", "ECONNREFUSED"].includes(code)) throw error;
  }
  ensurePrivateDirectory(home);
  const existing = await getPidLockInfo(home);
  const prior = await readDaemonRecovery(home);
  if (existing && isPidLockOwnerRunning(existing) && !prior)
    throw new Error("Existing daemon is attach-only; recovery ownership is unproven");
  const saved =
    launch ??
    launchSchema.parse(
      JSON.parse(await readFile(join(home, "daemon-recovery-launch.json"), "utf8")),
    );
  const env = {
    ...saved.env,
    PASEO_HOME: home,
    PASEO_DAEMON_COORDINATOR: "1",
    PASEO_DAEMON_GENERATION: undefined,
    PASEO_COORDINATOR_LAUNCH: JSON.stringify({ command: saved.command, args: saved.args }),
  };
  const child = spawn(saved.command, saved.args, { env, detached: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      await requestDaemonRecovery(home, "status");
      return;
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(String((error as NodeJS.ErrnoException).code)))
        throw error;
    }
    await delay(100);
  }
  throw new Error("Daemon recovery coordinator did not start; check daemon-recovery.log");
}

export async function prepareCoordinatedDaemonLaunch(input: {
  home: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await ensureDaemonCoordinator(input.home, {
    ...input,
    env: daemonLaunchEnvironment({ ...input, mode: "managed", desktopManaged: true }),
  });
}

export async function startCoordinatedDaemon(input: {
  home: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onAcquired?: (instance: PidLockInfo) => void;
  onReady?: (instance: PidLockInfo & { listen: string }) => void;
}): Promise<{ instance: PidLockInfo; spawned: boolean }> {
  const before = await getPidLockInfo(input.home);
  // A preexisting independent instance is never adopted from a PID file flag.
  if (before && isPidLockOwnerRunning(before) && !(await readDaemonRecovery(input.home)))
    return { instance: before, spawned: false };
  await prepareCoordinatedDaemonLaunch(input);
  await requestDaemonRecovery(input.home, "start");
  const instance = await getPidLockInfo(input.home);
  if (!instance?.listen) throw new Error("Managed daemon did not become ready");
  input.onAcquired?.(instance);
  input.onReady?.({ ...instance, listen: instance.listen });
  return { instance, spawned: !before };
}

export async function runDaemonCoordinator(home: string): Promise<void> {
  process.title = "Paseo Recovery";
  ensurePrivateDirectory(home);
  const native = helperPath();
  await access(native);
  const log = createStream("daemon-recovery.log", {
    path: home,
    size: "10M",
    maxFiles: 3,
    mode: 0o600,
  });
  log.on("error", () => {});
  const record = (event: string, fields: Record<string, unknown> = {}) =>
    log.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
  const helper = spawn(native, ["watch", join(home, "daemon-recovery.lock")], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let snapshot: NativeProcess[] = [];
  let snapshotAt = 0;
  let buffer = "";
  let helperFailed = false;
  helper.on("exit", () => {
    helperFailed = true;
  });
  helper.on("error", () => {
    helperFailed = true;
  });
  helper.stdout!.on("data", (chunk) => {
    buffer += chunk.toString();
    let split: number;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      try {
        snapshot = z.array(processSchema).parse(JSON.parse(line));
        snapshotAt = Date.now();
      } catch {
        helperFailed = true;
      }
    }
  });
  // The first snapshot is emitted only after the kernel lock has been acquired.
  const observerDeadline = Date.now() + limits.responseMs;
  while (Date.now() < observerDeadline) {
    if (snapshotAt || helperFailed) break;
    await delay(25);
  }
  if (!snapshotAt && !helperFailed) throw new Error("Native observer startup timed out");
  if (helperFailed) {
    log.end();
    return;
  }
  const prior = await readDaemonRecovery(home);
  const raw = JSON.parse(process.env.PASEO_COORDINATOR_LAUNCH!);
  const env = { ...process.env };
  delete env.PASEO_DAEMON_COORDINATOR;
  delete env.PASEO_COORDINATOR_LAUNCH;
  delete env.PASEO_DAEMON_GENERATION;
  const launch: Launch = {
    command: raw.command,
    args: raw.args,
    env,
    fingerprint: await fingerprint(raw.command, raw.args),
  };
  const saved = await readFile(join(home, "daemon-recovery-launch.json"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (saved && launchSchema.parse(JSON.parse(saved)).fingerprint !== launch.fingerprint) {
    record("runtime_changed");
    helper.kill();
    log.end();
    throw new Error("Recovery runtime changed; refusing stale launch");
  }
  await writeRecoveryJson(home, "daemon-recovery-launch.json", launch);
  let state: RecoveryState = prior ?? {
    generation: randomUUID(),
    desired: false,
    monitoring: true,
    attempts: 0,
    status: "stopped",
    error: null,
    processes: [],
  };
  const coordinator = snapshot.find((p) => p.pid === process.pid);
  if (!coordinator) throw new Error("Coordinator native identity unavailable");
  state.coordinator = {
    pid: coordinator.pid,
    startedAt: coordinator.startedAt,
    uid: coordinator.uid,
    executable: coordinator.executable,
  };
  const policy = new DaemonHealthWindow();
  policy.attempts = state.attempts;
  let child: ChildProcess | null = null;
  let childReadyAt = Date.now();
  let active: Promise<void> | null = null;
  let activeKind: "health" | "replace" = "replace";
  let intentRevision = 0;
  const pending = new Map<string, (message: { healthy: boolean; listen: string | null }) => void>();
  let writes = Promise.resolve();
  const persist = () => {
    state.attempts = policy.attempts;
    const value = structuredClone(state);
    writes = writes
      .catch(() => {})
      .then(() => writeRecoveryJson(home, "daemon-recovery.json", value));
    return writes;
  };
  let stoppingGeneration = false;
  const remember = async () => {
    if (helperFailed || Date.now() - snapshotAt > 6_000)
      throw new Error("Native identity observer unavailable");
    const root = snapshot.find(
      (p) =>
        child?.pid === p.pid &&
        p.parent === process.pid &&
        child.exitCode === null &&
        child.signalCode === null,
    );
    state.processes = collectGenerationProcesses(snapshot, state, root?.pid);
    await persist();
  };
  const supervisorProbe = async (): Promise<{ healthy: boolean; listen: string | null }> => {
    if (!child?.connected) return { healthy: false, listen: null };
    const id = randomUUID();
    let response: { healthy: boolean; listen: string | null } | undefined;
    pending.set(id, (message) => {
      response = message;
    });
    child.send({ type: "paseo:coordinator-probe", requestId: id }, () => {});
    const deadline = Date.now() + limits.responseMs;
    try {
      while (Date.now() < deadline) {
        if (response) return response;
        await delay(25);
      }
      return { healthy: false, listen: null };
    } finally {
      pending.delete(id);
    }
  };
  const health = async (): Promise<boolean> => {
    const response = await supervisorProbe();
    if (!response.healthy || !response.listen) {
      record("health_observation", {
        supervisorWorkerReply: response.healthy,
        endpointPublished: Boolean(response.listen),
        generation: state.generation,
      });
      return false;
    }
    try {
      await withLocalDaemon(home, response.listen, (c) => c.ping({ timeoutMs: limits.responseMs }));
      return true;
    } catch (error) {
      record("health_observation", {
        supervisorWorkerReply: true,
        applicationPing: false,
        code: (error as { code?: string }).code ?? "CONNECTION_FAILED",
        generation: state.generation,
      });
      if ((error as Error).name === "DaemonAuthenticationError") throw error;
      return false;
    }
  };
  const recordConfirmedStop = (
    instance: PidLockInfo | null,
    hadProcesses: boolean,
    forced: boolean,
    usedLifecycleRpc: boolean,
  ): void => {
    state.lastStop = {
      action: hadProcesses ? "stopped" : "not_running",
      pid: instance?.pid ?? null,
      forced,
      usedLifecycleRpc,
    };
    record("stop_completed", {
      ...state.lastStop,
      operationId: state.operationId,
      generation: state.generation,
    });
  };
  const stopOld = async (force: boolean, recovery = false) => {
    stoppingGeneration = true;
    await remember();
    const instance = await getPidLockInfo(home);
    captureRecoveryRoot(instance, snapshot, state);
    await persist();
    const alive = () =>
      state.processes.filter((p) =>
        snapshot.some((s) => s.pid === p.pid && s.startedAt === p.startedAt),
      );
    const hadProcesses = alive().length > 0;
    let usedLifecycleRpc = false;
    if (instance?.listen)
      usedLifecycleRpc = await requestRecoveryShutdown(home, instance.listen, force);
    else if (!force && alive().length) throw new Error("No graceful shutdown channel");
    const deadline = Date.now() + limits.shutdownMs;
    while (alive().length && Date.now() < deadline) await delay(100);
    if (alive().length && !force) throw new Error("Graceful stop was not confirmed");
    if (recovery && !state.desired) throw new Error("Recovery cancelled by stop intent");
    const forced = alive().length > 0;
    const targets = alive();
    for (let i = targets.length - 1; i >= 0; i--) {
      const p = targets[i];
      record("signal", { generation: state.generation, process: p, signal: "SIGKILL" });
      // The native helper rechecks uid and creation time immediately before kill().
      await execute(native, ["signal", String(p.pid), p.startedAt, "SIGKILL"], {
        timeout: limits.responseMs,
      }).catch((error) => {
        if (error.code !== 3) throw error;
      });
    }
    const killDeadline = Date.now() + limits.killedMs;
    while (alive().length && Date.now() < killDeadline) await delay(100);
    if (alive().length) throw new Error("Old daemon generation still exists");
    if (instance) {
      const current = await getPidLockInfo(home);
      if (current && !isSamePidLock(instance, current))
        throw new Error("Daemon replaced during cleanup");
      await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
    }
    recordConfirmedStop(instance, hadProcesses, forced, usedLifecycleRpc);
    child = null;
    stoppingGeneration = false;
    return forced;
  };
  const launchGeneration = async () => {
    if (!state.desired || !state.monitoring) return;
    if ((await fingerprint(launch.command, launch.args)) !== launch.fingerprint)
      throw new Error("Bundled runtime changed or unavailable");
    const existing = await getPidLockInfo(home);
    if (existing && isPidLockOwnerRunning(existing))
      throw new Error("Existing daemon must be verified and stopped before launch");
    if (existing)
      await releasePidLock(home, { ownerPid: existing.pid, startedAt: existing.startedAt });
    state.generation = randomUUID();
    state.processes = [];
    state.status = "starting";
    await persist();
    childReadyAt = Date.now();
    const next = spawn(launch.command, launch.args, {
      env: { ...launch.env, PASEO_DAEMON_GENERATION: state.generation },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child = next;
    next.on("message", (message: unknown) => {
      if (child !== next) return;
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "paseo:coordinator-restart-intent"
      ) {
        record("restart_intent", {
          reason: "reason" in message ? message.reason : "worker_exit",
          generation: state.generation,
        });
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "paseo:coordinator-stop-intent" &&
        "requestId" in message &&
        typeof message.requestId === "string"
      ) {
        const requestId = message.requestId;
        if (!stoppingGeneration) state.desired = false;
        void persist()
          .then(() => {
            if (next.connected)
              next.send({ type: "paseo:coordinator-intent-saved", requestId }, () => {});
            return undefined;
          })
          .catch((error) => record("intent_write_failed", { message: error.message }));
        return;
      }
      const parsed = z
        .object({
          type: z.literal("paseo:coordinator-health"),
          requestId: z.string(),
          healthy: z.boolean(),
          listen: z.string().nullable(),
        })
        .safeParse(message);
      if (parsed.success) pending.get(parsed.data.requestId)?.(parsed.data);
    });
    next.on("error", (error) => record("spawn_error", { message: error.message }));
    next.on("exit", (code, signal) =>
      record("supervisor_exit", { code, signal, generation: state.generation }),
    );
    while (state.desired && Date.now() - childReadyAt < limits.startupMs) {
      await remember();
      if (await health()) {
        snapshot = await nativeProcessSnapshot();
        snapshotAt = Date.now();
        await remember();
        const supervisor = snapshot.find((p) => p.pid === child?.pid && p.parent === process.pid);
        if (!supervisor || !state.processes.some((p) => p.parent === supervisor.pid)) {
          await delay(100);
          continue;
        }
        state.status = "healthy";
        state.error = null;
        policy.resetObservations();
        await persist();
        record("ready", {
          generation: state.generation,
          build: launch.fingerprint,
          operationId: state.operationId,
        });
        return;
      }
      await delay(250);
    }
    if (state.desired) throw new Error("Daemon startup exceeded sixty seconds");
  };
  const recover = async (manual: boolean, restart = false) => {
    if (!state.desired || !state.monitoring) return;
    if (!restart && (await health())) {
      state.status = "healthy";
      state.error = null;
      await persist();
      return;
    }
    if (!manual && policy.attempts >= limits.retryMs.length)
      throw new Error("Automatic recovery budget exhausted");
    if (manual) policy.attempts = 0;
    activeKind = "replace";
    const incident = randomUUID();
    state.operationId = incident;
    state.status = "recovering";
    state.error = null;
    await persist();
    record("incident", {
      incident,
      generation: state.generation,
      processes: state.processes,
      manual,
    });
    if (!manual) {
      const backoff = limits.retryMs[policy.attempts++];
      await persist();
      await delay(backoff);
      if (!state.desired || !state.monitoring) return;
      if (await health()) {
        state.status = "healthy";
        state.error = null;
        policy.resetObservations();
        await persist();
        return;
      }
    }
    if ((await fingerprint(launch.command, launch.args)) !== launch.fingerprint)
      throw new Error("Bundled runtime changed or unavailable; preserving the old generation");
    if (!state.desired || !state.monitoring) return;
    const forced = await stopOld(true, true);
    if (forced) {
      const modulePath = new URL(
        "../../server/server/daemon-recovery-interruption.js",
        import.meta.url,
      );
      const { markInterruptedDaemonTurns } = await import(modulePath.href);
      await markInterruptedDaemonTurns(home);
    }
    if (state.desired && state.monitoring) await launchGeneration();
  };
  const run = (
    action: () => Promise<unknown>,
    kind: "health" | "replace" = "replace",
  ): Promise<void> => {
    if (active)
      return activeKind === kind
        ? active
        : active.then(
            () => run(action, kind),
            () => run(action, kind),
          );
    activeKind = kind;
    if (kind === "replace") state.operationId = randomUUID();
    active = action()
      .then(() => undefined)
      .catch(async (error) => {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        record("failed", { error: state.error, generation: state.generation });
        await persist();
        throw error;
      })
      .finally(() => {
        stoppingGeneration = false;
        active = null;
      });
    return active;
  };
  await persist();
  await unlink(recoverySocket(home)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const handleCommand = async (socket: Socket, input: string): Promise<void> => {
    const { command } = z
      .object({
        command: z.enum(["status", "start", "stop", "stop_force", "recover", "restart", "disable"]),
      })
      .parse(JSON.parse(input));
    if (command === "status") {
      socket.end(`${JSON.stringify(state)}\n`);
      return;
    }
    if ((command === "recover" || command === "restart") && !state.monitoring)
      throw new Error("Built-in daemon management is disabled");
    const intent = ++intentRevision;
    // Publish stop intent before joining any active operation. It cancels delayed relaunches.
    if (command === "stop" || command === "stop_force" || command === "disable") {
      state.desired = false;
      if (command === "disable") state.monitoring = false;
      await persist();
      await active?.catch(() => {});
      if (intent !== intentRevision) {
        socket.end(`${JSON.stringify(state)}\n`);
        return;
      }
      if (command !== "disable") await run(() => stopOld(command === "stop_force"));
      state.status = command !== "disable" ? "stopped" : "disabled";
    } else {
      state.desired = true;
      state.monitoring = true;
      await persist();
      let action = () => recover(true, command === "restart");
      if (command === "start" && !child && !state.processes.length) action = launchGeneration;
      await run(action);
    }
    await persist();
    socket.end(`${JSON.stringify(state)}\n`);
  };
  const server = createServer((socket) => {
    socket.setTimeout(175_000, () => socket.destroy());
    let input = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      void handleCommand(socket, input).catch((error) =>
        socket.end(
          `${JSON.stringify({ error: { code: error.code ?? "RECOVERY_FAILED", message: error.message } })}\n`,
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(recoverySocket(home), resolve);
  });
  record("coordinator_ready", { build: launch.fingerprint });
  const tick = setInterval(() => {
    if (helperFailed) {
      record("identity_observer_lost");
      server.close();
      clearInterval(tick);
      process.exit(1);
    }
    if (active || !state.desired || !state.monitoring) return;
    void run(async () => {
      await remember();
      const healthy = await health();
      if (policy.observe(Date.now(), healthy)) await recover(false);
      else {
        if (healthy) {
          state.status = "healthy";
          state.error = null;
        }
        await persist();
      }
    }, "health").catch(() => {});
  }, limits.intervalMs);
  // Recovered coordinators do not trust a surviving generation until native identities match.
  if (state.desired && state.monitoring) void run(() => recover(false)).catch(() => {});
}

export async function managedDaemonCommand(
  home: string,
  command: RecoveryCommand,
): Promise<RecoveryState> {
  await ensureDaemonCoordinator(
    home,
    undefined,
    ["recover", "restart", "stop_force"].includes(command),
  );
  return requestDaemonRecovery(home, command);
}
