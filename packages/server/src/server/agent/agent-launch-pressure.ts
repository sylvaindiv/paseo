import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";

export function readMacMemoryPressure(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      {
        timeout: 1000,
      },
      (error, stdout) => {
        const level = stdout.trim();
        // The kernel exposes dispatch pressure flags through this sysctl.
        if (error) return resolve(null);
        if (level === "2" || level === "4") return resolve(true);
        return resolve(level === "1" ? false : null);
      },
    );
  });
}

export class AgentLaunchStoppedError extends Error {
  readonly code = "agent_launch_stopped";
}

interface WaitingLaunch {
  agentId: string | undefined;
  start: () => Promise<void>;
  onWaiting?: () => void;
  reject: (reason: Error) => void;
}

export class AgentLaunchPressure {
  private readonly waiting: WaitingLaunch[] = [];
  private normalSince: number | null = null;
  private recovering = false;
  private checking = false;
  private reading: Promise<boolean | null> | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly readPressure: () => Promise<boolean | null>,
    private readonly onPressure: () => void,
    private readonly now = () => performance.now(),
  ) {}

  launch<T>(
    agentId: string | undefined,
    operation: () => Promise<T>,
    onWaiting?: () => void,
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new AgentLaunchStoppedError("Daemon is shutting down"));
    return new Promise((resolve, reject) => {
      this.waiting.push({
        agentId,
        onWaiting,
        start: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
        reject,
      });
      void this.check();
    });
  }

  cancel(agentId: string): void {
    const canceled = this.waiting.filter((launch) => launch.agentId === agentId);
    for (const launch of canceled) {
      this.waiting.splice(this.waiting.indexOf(launch), 1);
      launch.reject(new Error("Agent launch canceled"));
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const launch of this.waiting.splice(0))
      launch.reject(new AgentLaunchStoppedError("Daemon is shutting down"));
  }

  observe(): Promise<boolean | null> {
    this.reading ??= Promise.resolve()
      .then(this.readPressure)
      .catch(() => null)
      .then((pressure) => {
        if (pressure === true) {
          if (!this.recovering) this.onPressure();
          this.recovering = true;
          this.normalSince = null;
        } else if (this.recovering) {
          this.normalSince = pressure === false ? (this.normalSince ?? this.now()) : null;
        }
        return pressure;
      })
      .finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }

  private async check(): Promise<void> {
    if (this.checking || this.timer || this.stopped) return;
    this.checking = true;
    try {
      while (this.waiting.length > 0 && !this.stopped) {
        await this.observe();
        if (this.stopped) break;
        if (
          this.recovering &&
          (this.normalSince === null || this.now() - this.normalSince < 30_000)
        ) {
          for (const launch of this.waiting) {
            launch.onWaiting?.();
            launch.onWaiting = undefined;
          }
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.check();
          }, 1_000);
          this.timer.unref();
          return;
        }
        const launch = this.waiting.shift();
        if (!launch) break;
        const started = launch.start();
        if (this.recovering) await started;
      }
      if (this.normalSince !== null && this.now() - this.normalSince >= 30_000) {
        this.recovering = false;
        this.normalSince = null;
      }
    } finally {
      this.checking = false;
    }
  }
}
