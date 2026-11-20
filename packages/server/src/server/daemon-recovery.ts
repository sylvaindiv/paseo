import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createStream } from "rotating-file-stream";
import { z } from "zod";
import {
  nativeProcessHelper,
  nativeProcessSchema,
  nativeProcessSnapshot,
  signalNativeProcess,
  type NativeProcess,
} from "./native-process.js";
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
  publicRecoveryState,
  writeRecoveryJson,
  type RecoveryState,
  type RecoveryCommand,
} from "./daemon-recovery-client.js";
import { withLocalDaemon } from "./daemon-recovery-health.js";
const execute = promisify(execFile);
const launchSchema = z.object({
  command: z.string().refine(isAbsolute),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string().optional()),
  fingerprint: z.string(),
  archiveRevision: z.string().nullable().optional(),
});
type Launch = z.infer<typeof launchSchema>;
type LaunchInput = Omit<Launch, "fingerprint">;

export function collectGenerationProcesses(
  snapshot: NativeProcess[],
  state: RecoveryState,
  rootPid?: number,
): RecoveryState["processes"] {
  const prior = new Map(state.processes.map((p) => [`${p.pid}:${p.startedAt}`, p]));
  const descendants = new Map<number, NativeProcess[]>();
  const owned = new Map<number, NativeProcess>();
  for (const p of snapshot) {
    if (p.shared === "1" || (p.generation && p.generation !== state.generation)) continue;
    const children = descendants.get(p.parent) ?? [];
    children.push(p);
    descendants.set(p.parent, children);
    const previous = prior.get(`${p.pid}:${p.startedAt}`);
    if (
      p.pid === rootPid ||
      p.generation === state.generation ||
      (previous?.startedAt === p.startedAt &&
        (previous.uid === undefined || previous.uid === p.uid))
    )
      owned.set(p.pid, p);
  }
  const queue = [...owned.values()];
  for (const parent of queue) {
    for (const child of descendants.get(parent.pid) ?? []) {
      if (owned.has(child.pid)) continue;
      owned.set(child.pid, child);
      queue.push(child);
    }
  }
  return queue;
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
    if (instance.uid !== root.uid) throw new Error("Daemon owner changed; refusing cleanup");
    if (!captured && !published) {
      if (instance.generation === state.generation && instance.nativeStartedAt) return;
      throw new Error("Daemon identity is unproven; refusing cleanup");
    }
    state.processes = collectGenerationProcesses(snapshot, state, root.pid);
  }
}

async function releaseStoppedInstance(home: string, instance: PidLockInfo) {
  const current = await getPidLockInfo(home);
  if (current && !isSamePidLock(instance, current))
    throw new Error("Daemon replaced during cleanup");
  await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
}

async function requestRecoveryShutdown(
  home: string,
  listen: string,
  force: boolean,
  disconnected: boolean,
  instance: PidLockInfo,
): Promise<boolean> {
  try {
    await withLocalDaemon<unknown>(
      home,
      listen,
      (c) =>
        disconnected
          ? c.restartServer("coordinator_replacement", undefined, { timeout: limits.shutdownMs })
          : c.shutdownServer({ timeout: limits.shutdownMs }),
      instance,
    );
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

function runtimeArchive(args: string[]): string | undefined {
  const path = args.find((arg) => arg.includes(".asar/"))?.split(".asar/")[0];
  return path && `${path}.asar`;
}

async function archiveRevision(archive: string | undefined): Promise<string | null> {
  if (!archive) return null;
  const nativeStat = process.versions.electron
    ? (createRequire(import.meta.url)("original-fs") as typeof import("node:fs")).promises.stat
    : stat;
  const info = await nativeStat(archive);
  return `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
}

export async function fingerprint(command: string, args: string[]): Promise<string> {
  const runner = args.find((arg) => arg.endsWith("/dist/scripts/supervisor-entrypoint.js"));
  const module = runner
    ? new URL("../server/server/daemon-recovery.js", pathToFileURL(runner))
    : new URL(import.meta.url);
  if (runner?.includes(".asar/") && !existsSync(runner)) {
    if (process.versions.electron) throw new Error("Bundled daemon runner unavailable");
    await verifyCandidateBundle(command);
    const { stdout } = await execute(
      command,
      [
        "--input-type=module",
        "-e",
        `const { fingerprint } = await import(${JSON.stringify(import.meta.url)});
      console.log(await fingerprint(...JSON.parse(process.argv[1])));`,
        JSON.stringify([command, args]),
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 },
    );
    return stdout.trim();
  }
  const hash = createHash("sha256");
  const files = new Set([
    command,
    ...args.filter((a) => existsSync(a)),
    runner
      ? fileURLToPath(new URL("./paseo-browser-resource", module)).replace(
          /\.asar\//,
          ".asar.unpacked/",
        )
      : nativeProcessHelper(),
  ]);
  for (const relative of [
    "./daemon-worker.js",
    "../../server/server/daemon-worker.js",
    "../../scripts/supervisor.js",
    "../../scripts/supervisor-entrypoint.js",
  ]) {
    const file = fileURLToPath(new URL(relative, module));
    if (existsSync(file)) files.add(file);
  }
  let packageRoot = dirname(fileURLToPath(module));
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

async function killVerifiedProcess(identity: Pick<NativeProcess, "pid" | "startedAt">) {
  await signalNativeProcess(identity, "SIGKILL").catch((error) => {
    if (error.code !== 3) throw error;
  });
}

async function replaceCoordinator(expected: RecoveryState["coordinator"]): Promise<void> {
  if (!expected || expected.uid !== process.getuid?.())
    throw new Error("Coordinator native identity is unproven");
  const actual = (await nativeProcessSnapshot()).find((p) => p.pid === expected.pid);
  if (actual?.startedAt !== expected.startedAt) return;
  if (actual.uid !== expected.uid) throw new Error("Coordinator owner changed");
  await killVerifiedProcess(actual);
}

async function startLockedObserver(path: string, timeoutMs: number): Promise<ChildProcess> {
  const deadline = Date.now() + timeoutMs;
  const native = nativeProcessHelper();
  while (Date.now() < deadline) {
    const observer = spawn(native, ["watch", path], { stdio: ["ignore", "pipe", "ignore"] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await new Promise<boolean>((resolve, reject) => {
      timer = setTimeout(
        () => {
          observer.kill();
          reject(new Error("Native process observer did not start"));
        },
        Math.max(1, deadline - Date.now()),
      );
      observer.on("error", reject);
      observer.once("exit", (code) => {
        if (code === 73) resolve(false);
        else reject(new Error("Native process observer exited"));
      });
      observer.stdout!.once("readable", () => {
        if (observer.stdout!.readableLength) resolve(true);
      });
    }).finally(() => clearTimeout(timer));
    if (acquired) return observer;
    await delay(100);
  }
  throw new Error("Recovery observer lock timed out");
}

async function withTakeoverLock(home: string, action: () => Promise<void>): Promise<void> {
  const lock = await startLockedObserver(join(home, "daemon-recovery-takeover.lock"), 60_000);
  lock.stdout!.resume();
  try {
    await action();
  } finally {
    lock.kill();
  }
}

export async function ensureDaemonCoordinator(
  home: string,
  launch?: LaunchInput,
  recoverUnresponsive = false,
): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Managed recovery requires macOS");
  ensurePrivateDirectory(home);
  await withTakeoverLock(await realpath(home), () =>
    ensureCoordinatorLocked(home, launch, recoverUnresponsive),
  );
}

const coordinatorUnavailable = (error: NodeJS.ErrnoException) =>
  ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "RECOVERY_CONNECTION_CLOSED"].includes(
    error.code ?? "",
  );

async function readAvailableStatus(
  home: string,
  recoverUnresponsive: boolean,
  hasCurrentBundle: boolean,
) {
  try {
    return await requestDaemonRecovery(home, "status");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      coordinatorUnavailable(error as NodeJS.ErrnoException) ||
      (hasCurrentBundle && code === "RECOVERY_RESPONSE_TOO_LARGE") ||
      (recoverUnresponsive && code === "RECOVERY_COORDINATOR_TIMEOUT")
    )
      return null;
    throw error;
  }
}

async function verifyCandidateBundle(command: string): Promise<void> {
  const bundle = command.match(/^(.*?\.app)\/Contents\//)?.[1];
  if (bundle)
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
      timeout: 30_000,
    });
}

async function waitForIdleCoordinator(
  status: RecoveryState | null,
  readStatus: () => Promise<RecoveryState | null>,
): Promise<RecoveryState | null> {
  const deadline = Date.now() + 20_000;
  while (status && ["recovering", "starting"].includes(status.status)) {
    if (Date.now() >= deadline) throw new Error("Coordinator replacement is already in progress");
    await delay(250);
    status = await readStatus();
  }
  return status;
}

async function ensureCoordinatorLocked(
  home: string,
  launch: LaunchInput | undefined,
  recoverUnresponsive: boolean,
): Promise<void> {
  const readStatus = () => readAvailableStatus(home, recoverUnresponsive, Boolean(launch));
  let status = await readStatus();
  const prior = await readDaemonRecovery(home);
  const recorded = await readFile(join(home, "daemon-recovery-launch.json"), "utf8")
    .then((raw) => launchSchema.parse(JSON.parse(raw)))
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const candidate = launch ?? recorded;
  if (!candidate) throw new Error("No saved recovery launch is available");
  const build = await fingerprint(candidate.command, candidate.args);
  const archive = runtimeArchive(candidate.args);
  const revision = await archiveRevision(archive);
  if (!launch && build !== recorded?.fingerprint)
    throw new Error("Bundled recovery runtime changed; use the bundled CLI");
  if (
    status &&
    build === recorded?.fingerprint &&
    (recorded.archiveRevision === undefined || recorded.archiveRevision === revision)
  )
    return;
  const existing = await getPidLockInfo(home);
  if (existing && isPidLockOwnerRunning(existing) && !prior)
    throw new Error("Existing daemon is attach-only; recovery ownership is unproven");

  await verifyCandidateBundle(candidate.command);
  status = await waitForIdleCoordinator(status, readStatus);
  if ((await archiveRevision(archive)) !== revision)
    throw new Error("Bundled runtime changed during verification");
  const previous = await readDaemonRecovery(home);
  if (previous?.coordinator) await replaceCoordinator(previous.coordinator);
  else if (status) throw new Error("Coordinator native identity is unproven");
  await spawnCoordinator(home, {
    ...candidate,
    fingerprint: build,
    archiveRevision: revision,
  });
}

async function spawnCoordinator(home: string, saved: Launch): Promise<void> {
  const env = {
    ...saved.env,
    PASEO_HOME: home,
    PASEO_DAEMON_COORDINATOR: "1",
    PASEO_DAEMON_GENERATION: undefined,
    PASEO_COORDINATOR_LAUNCH: JSON.stringify({
      command: saved.command,
      args: saved.args,
      fingerprint: saved.fingerprint,
      archiveRevision: saved.archiveRevision,
    }),
  };
  const child = spawn(saved.command, saved.args, { env, detached: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    spawnError = new Error(`Recovery coordinator exited (${signal ?? code}); check daemon.log`);
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      const reply = await requestDaemonRecovery(home, "status");
      if (reply.coordinator?.pid === child.pid) return;
    } catch (error) {
      if (!coordinatorUnavailable(error as NodeJS.ErrnoException)) throw error;
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
  const log = createStream("daemon-recovery.log", {
    path: home,
    size: "10M",
    maxFiles: 3,
    mode: 0o600,
  });
  log.on("error", () => {});
  const record = (event: string, fields: Record<string, unknown> = {}) =>
    log.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
  const helper = await startLockedObserver(join(home, "daemon-recovery.lock"), 8_000);
  let snapshot: NativeProcess[] = [];
  let snapshotAt = 0;
  let onObservation: (() => void) | undefined;
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
        snapshot = z.array(nativeProcessSchema).parse(JSON.parse(line));
        snapshotAt = Date.now();
        onObservation?.();
      } catch {
        helperFailed = true;
      }
    }
  });
  helper.stdout!.resume();
  // The first snapshot is emitted only after the kernel lock has been acquired.
  const observerDeadline = Date.now() + limits.responseMs;
  while (Date.now() < observerDeadline) {
    if (snapshotAt || helperFailed) break;
    await delay(25);
  }
  if (!snapshotAt && !helperFailed) throw new Error("Native observer startup timed out");
  if (helperFailed) throw new Error("Native observer startup failed");
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
    archiveRevision: await archiveRevision(runtimeArchive(raw.args)),
  };
  if (raw.fingerprint !== launch.fingerprint || raw.archiveRevision !== launch.archiveRevision) {
    helper.kill();
    log.end();
    throw new Error("Recovery runtime changed during takeover");
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
  const verifiedSnapshot = () => {
    if (helperFailed || Date.now() - snapshotAt > 6_000)
      throw new Error("Native identity observer unavailable");
    return snapshot;
  };
  const compact = () => {
    const root = snapshot.find(
      (p) =>
        child?.pid === p.pid &&
        p.parent === process.pid &&
        child.exitCode === null &&
        child.signalCode === null,
    );
    const next = collectGenerationProcesses(verifiedSnapshot(), state, root?.pid);
    if (JSON.stringify(next) === JSON.stringify(state.processes)) return;
    state.processes = next;
    return persist();
  };
  const remember = async () => {
    await compact();
  };
  onObservation = () => {
    void compact()?.catch((error) =>
      record("registry_write_failed", {
        message: error.message,
      }),
    );
  };
  await remember();
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
    let response = await supervisorProbe();
    let verifiedInstance: PidLockInfo | undefined;
    if (!child?.connected) {
      const instance = await getPidLockInfo(home);
      const root = verifiedSnapshot().find((p) => p.pid === instance?.pid);
      if (
        instance &&
        root &&
        root.shared !== "1" &&
        instance.generation === state.generation &&
        instance.nativeStartedAt === root.startedAt &&
        instance.uid === root.uid
      ) {
        verifiedInstance = instance;
        response = { healthy: true, listen: instance.listen };
      }
    }
    if (!response.healthy || !response.listen) {
      record("health_observation", {
        supervisorWorkerReply: response.healthy,
        endpointPublished: Boolean(response.listen),
        generation: state.generation,
      });
      return false;
    }
    try {
      await withLocalDaemon(
        home,
        response.listen,
        (c) => c.ping({ timeoutMs: limits.responseMs }),
        verifiedInstance,
      );
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
    const alive = () => {
      const current = new Map(verifiedSnapshot().map((p) => [p.pid, p]));
      return state.processes.filter((p) => {
        const observed = current.get(p.pid);
        return observed?.startedAt === p.startedAt && observed.uid === p.uid;
      });
    };
    const targetsBeforeShutdown = alive();
    const hadProcesses = targetsBeforeShutdown.length > 0;
    const endpoint = targetsBeforeShutdown.some((p) => p.pid === instance?.pid)
      ? instance?.listen
      : null;
    let usedLifecycleRpc = false;
    if (instance && endpoint)
      usedLifecycleRpc = await requestRecoveryShutdown(
        home,
        endpoint,
        force,
        !child?.connected,
        instance,
      );
    else if (!force && hadProcesses) throw new Error("No graceful shutdown channel");
    const deadline = Date.now() + limits.shutdownMs;
    while (alive().length && Date.now() < deadline) await delay(100);
    if (alive().length && !force) throw new Error("Graceful stop was not confirmed");
    if (recovery && !state.desired) throw new Error("Recovery cancelled by stop intent");
    const targets = alive();
    const forced = targets.length > 0;
    for (let i = targets.length - 1; i >= 0; i--) {
      const p = targets[i];
      record("signal", { generation: state.generation, process: p, signal: "SIGKILL" });
      // The native helper rechecks uid and creation time immediately before kill().
      await killVerifiedProcess(p);
    }
    const killDeadline = Date.now() + limits.killedMs;
    while (alive().length && Date.now() < killDeadline) await delay(100);
    if (alive().length) throw new Error("Old daemon generation still exists");
    if (instance) await releaseStoppedInstance(home, instance);
    recordConfirmedStop(instance, hadProcesses, forced, usedLifecycleRpc);
    child = null;
    stoppingGeneration = false;
    return forced;
  };
  const archive = runtimeArchive(launch.args);
  const currentRuntime = async () => {
    try {
      return (
        (await archiveRevision(archive)) === launch.archiveRevision &&
        (await fingerprint(launch.command, launch.args)) === launch.fingerprint
      );
    } catch {
      return false;
    }
  };
  const launchGeneration = async () => {
    if (!state.desired || !state.monitoring) return;
    if (!(await currentRuntime())) throw new Error("Bundled runtime changed or unavailable");
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
  const relayRecovery = async (manual: boolean) => {
    const cli = launch.env.PASEO_CLI;
    const bundledCli = archive && join(dirname(archive), "bin", "paseo");
    if (!manual && cli && cli === bundledCli) {
      // The shim opens the current installation even when this coordinator still has the old ASAR open.
      await execute(cli, ["daemon", "recover", "--automatic", "--home", home], {
        env: { ...launch.env, ELECTRON_RUN_AS_NODE: undefined },
        timeout: 60_000,
      });
    }
    throw new Error("Bundled runtime changed or unavailable; preserving the old generation");
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
    if (!(await currentRuntime())) await relayRecovery(manual);
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
      processCount: state.processes.length,
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
    if (!(await currentRuntime())) throw new Error("Bundled runtime changed during recovery");
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
  let pendingStart: { command: RecoveryCommand; intent: number; completion: Promise<void> } | null =
    null;
  const requestStart = async (command: RecoveryCommand): Promise<void> => {
    if (pendingStart?.command === command && pendingStart.intent === intentRevision)
      return pendingStart.completion;

    const intent = ++intentRevision;
    state.desired = true;
    state.monitoring = true;
    const completion = (async () => {
      await persist();
      if (intent !== intentRevision) return;
      await run(async () => {
        if (intent !== intentRevision) return;
        if (command === "start" && !(await getPidLockInfo(home)) && !state.processes.length)
          await launchGeneration();
        else await recover(true, command === "restart");
      });
    })();
    pendingStart = { command, intent, completion };
    try {
      await completion;
    } finally {
      if (pendingStart?.completion === completion) pendingStart = null;
    }
  };
  const handleCommand = async (socket: Socket, input: string): Promise<void> => {
    const { command } = z
      .object({
        command: z.enum(["status", "start", "stop", "stop_force", "recover", "restart", "disable"]),
      })
      .parse(JSON.parse(input));
    if (command === "status") {
      socket.end(`${JSON.stringify(publicRecoveryState(state))}\n`);
      return;
    }
    if ((command === "recover" || command === "restart") && !state.monitoring)
      throw new Error("Built-in daemon management is disabled");
    // Publish stop intent before joining any active operation. It cancels delayed relaunches.
    if (command === "stop" || command === "stop_force" || command === "disable") {
      const intent = ++intentRevision;
      state.desired = false;
      if (command === "disable") state.monitoring = false;
      await persist();
      await active?.catch(() => {});
      if (intent !== intentRevision) {
        socket.end(`${JSON.stringify(publicRecoveryState(state))}\n`);
        return;
      }
      if (command !== "disable") await run(() => stopOld(command === "stop_force"));
      state.status = command !== "disable" ? "stopped" : "disabled";
    } else {
      await requestStart(command);
    }
    await persist();
    socket.end(`${JSON.stringify(publicRecoveryState(state))}\n`);
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
          `${JSON.stringify({ error: { code: error.code ?? "RECOVERY_FAILED", message: String(error.message).slice(0, 2048) } })}\n`,
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
  // Takeovers use the regular health window and the persisted recovery budget.
}

export async function managedDaemonCommand(
  home: string,
  command: RecoveryCommand,
  launch?: LaunchInput,
  automatic = false,
): Promise<RecoveryState> {
  await ensureDaemonCoordinator(
    home,
    launch && {
      ...launch,
      env: daemonLaunchEnvironment({ ...launch, home, mode: "managed", desktopManaged: true }),
    },
    Boolean(launch) || ["recover", "restart", "stop_force"].includes(command),
  );
  return requestDaemonRecovery(home, automatic ? "status" : command);
}
