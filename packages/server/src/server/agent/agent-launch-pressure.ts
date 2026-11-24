import { execFile } from "node:child_process";

export type MacMemoryPressure = "normal" | "warning" | "critical";

export function readMacMemoryPressure(): Promise<MacMemoryPressure | null> {
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
        if (level === "4") return resolve("critical");
        if (level === "2") return resolve("warning");
        return resolve(level === "1" ? "normal" : null);
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
  private lastPressure: MacMemoryPressure | null = null;
  private starting = 0;
  private checking = false;
  private reading: Promise<MacMemoryPressure | null> | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly readPressure: () => Promise<MacMemoryPressure | null>,
    private readonly onPressure: () => void,
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
    if (!this.waiting.length) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const launch of this.waiting.splice(0))
      launch.reject(new AgentLaunchStoppedError("Daemon is shutting down"));
  }

  observe(): Promise<MacMemoryPressure | null> {
    this.reading ??= Promise.resolve()
      .then(this.readPressure)
      .catch(() => null)
      .then((pressure) => {
        const previous = this.lastPressure;
        if (pressure !== null) this.lastPressure = pressure;
        if (
          (pressure === "warning" || pressure === "critical") &&
          (previous === null || previous === "normal")
        )
          this.onPressure();
        return this.lastPressure === "critical" ? "critical" : pressure;
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
        const pressure = await this.observe();
        if (this.stopped) break;
        if (!this.waiting.length) break;
        if (pressure === "critical" || (pressure === "warning" && this.starting > 0)) {
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
        this.starting++;
        void launch.start().finally(() => {
          this.starting--;
          if (this.starting === 0 && this.lastPressure !== "critical") {
            clearTimeout(this.timer);
            this.timer = undefined;
            void this.check();
          }
        });
      }
    } finally {
      this.checking = false;
    }
  }
}
