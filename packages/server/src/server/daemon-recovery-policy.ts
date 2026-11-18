export const DAEMON_RECOVERY = {
  intervalMs: 5_000,
  responseMs: 2_000,
  failures: 4,
  observationMs: 20_000,
  startupMs: 60_000,
  shutdownMs: 15_000,
  killedMs: 3_000,
  retryMs: [5_000, 15_000, 45_000],
  rearmMs: 600_000,
} as const;

/** Missed observations after sleep are not evidence of a blocked daemon. */
export class DaemonHealthWindow {
  private lastAt = 0;
  private failedAt: number | null = null;
  private healthyAt: number | null = null;
  private failures = 0;
  attempts = 0;

  observe(now: number, healthy: boolean): boolean {
    if (this.lastAt && now - this.lastAt > DAEMON_RECOVERY.intervalMs * 3) {
      this.failedAt = null;
      this.healthyAt = null;
      this.failures = 0;
    }
    this.lastAt = now;
    if (healthy) {
      this.failedAt = null;
      this.failures = 0;
      this.healthyAt ??= now;
      if (now - this.healthyAt >= DAEMON_RECOVERY.rearmMs) this.attempts = 0;
      return false;
    }
    this.healthyAt = null;
    this.failedAt ??= now;
    this.failures++;
    return (
      this.failures >= DAEMON_RECOVERY.failures &&
      now - this.failedAt >= DAEMON_RECOVERY.observationMs
    );
  }

  resetObservations(): void {
    this.lastAt = 0;
    this.failedAt = null;
    this.healthyAt = null;
    this.failures = 0;
  }
}
