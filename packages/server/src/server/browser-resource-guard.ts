/** Policy input must contain only externally launched browsers with verified ownership. */
export interface BrowserResourceSession {
  id: string;
  bytes: number;
  ownerClosed: boolean;
  ownerLastActiveAt: number;
}

export interface BrowserResourceLimits {
  sessionBytes: number;
  totalBytes: number;
  recoveryBytes: number;
  idleMs: number;
  intervalMs: number;
  graceMs: number;
}
export const BROWSER_RESOURCE_LIMITS: BrowserResourceLimits = {
  sessionBytes: 2 * 1024 ** 3,
  totalBytes: 4 * 1024 ** 3,
  recoveryBytes: 3 * 1024 ** 3,
  idleMs: 300_000,
  intervalMs: 2_000,
  graceMs: 1_000,
} as const;

export type BrowserStopReason = "owner_closed" | "owner_idle" | "memory";

/** Computes a single shared budget; callers must deduplicate sessions before sampling. */
export function selectBrowserResourceStops(
  sessions: readonly BrowserResourceSession[],
  now: number,
  limits: BrowserResourceLimits = BROWSER_RESOURCE_LIMITS,
): { id: string; reason: BrowserStopReason }[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (
      ids.has(session.id) ||
      !Number.isFinite(session.bytes) ||
      session.bytes < 0 ||
      !Number.isFinite(session.ownerLastActiveAt)
    ) {
      throw new Error("Invalid browser resource sample");
    }
    ids.add(session.id);
  }
  const stops: { id: string; reason: BrowserStopReason }[] = [];
  const remaining: BrowserResourceSession[] = [];
  for (const session of sessions) {
    let reason: BrowserStopReason | null = null;
    if (session.ownerClosed) reason = "owner_closed";
    else if (now - session.ownerLastActiveAt >= limits.idleMs) reason = "owner_idle";
    else if (session.bytes > limits.sessionBytes) reason = "memory";
    if (reason) stops.push({ id: session.id, reason });
    else remaining.push(session);
  }
  let total = remaining.reduce((sum, session) => sum + session.bytes, 0);
  if (sessions.reduce((sum, session) => sum + session.bytes, 0) > limits.totalBytes) {
    remaining.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
    for (const session of remaining) {
      if (total < limits.recoveryBytes) break;
      stops.push({ id: session.id, reason: "memory" });
      total -= session.bytes;
      if (total < limits.recoveryBytes) break;
    }
  }
  return stops;
}

export interface BrowserProcessIdentity {
  pid: number;
  /** Kernel process start timestamp, never the observation time. */
  startedAt: string;
}

/** Each signal requires a fresh kernel identity check, including after the grace period. */
export async function stopBrowserProcesses(
  processes: readonly BrowserProcessIdentity[],
  operations: {
    identify: (pid: number) => Promise<BrowserProcessIdentity | null>;
    signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
    wait: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const signalMatching = async (signal: "SIGTERM" | "SIGKILL") => {
    for (const process of processes) {
      if (!Number.isSafeInteger(process.pid) || process.pid <= 1 || !process.startedAt) {
        throw new Error("Invalid browser process identity");
      }
      const current = await operations.identify(process.pid);
      if (current?.pid === process.pid && current.startedAt === process.startedAt) {
        await operations.signal(process.pid, signal);
      }
    }
  };
  await signalMatching("SIGTERM");
  await operations.wait(BROWSER_RESOURCE_LIMITS.graceMs);
  await signalMatching("SIGKILL");
}
