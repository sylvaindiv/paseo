import { CdpSessionQueue } from "./cdp-session-queue.js";

export const PARKED_BROWSER_IDLE_MS = 60_000;
export const PARKED_BROWSER_DISCARD_MS = 15 * 60_000;

interface PageContents {
  isDestroyed(): boolean;
  isLoading(): boolean;
  getBackgroundThrottling(): boolean;
  isCurrentlyAudible?(): boolean;
  isDevToolsOpened?(): boolean;
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(command: string, params: Record<string, unknown>): Promise<unknown>;
  };
}

/** Hidden pages freeze first, then release their guest after verified inactivity. */
export class BrowserPageLifecycle {
  private presented = true;
  private lastUsedAt = Date.now();
  private downloads = 0;
  private discardTimer: ReturnType<typeof setTimeout> | undefined;
  private discard: (() => void) | undefined;
  public released = 0;
  public retentionReason = "presented";
  private frozen = false;
  private leases = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly contents: PageContents,
    private readonly queue: CdpSessionQueue,
  ) {}

  async setPresented(presented: boolean): Promise<void> {
    if (this.presented !== presented) this.lastUsedAt = Date.now();
    this.presented = presented;
    this.retentionReason = presented ? "presented" : "recent-use";
    this.clearTimer();
    this.scheduleDiscard();
    if (presented) await this.setFrozen(false);
    else this.schedule();
  }

  async withAutomation<T>(task: () => Promise<T>): Promise<T> {
    // Acquire synchronously, before any queued freeze can run.
    this.leases++;
    this.retentionReason = "automation";
    this.lastUsedAt = Date.now();
    this.clearTimer();
    this.scheduleDiscard();
    try {
      await this.setFrozen(false);
      return await task();
    } finally {
      this.leases--;
      this.retentionReason = this.presented ? "presented" : "recent-use";
      this.lastUsedAt = Date.now();
      this.schedule();
      this.scheduleDiscard();
    }
  }

  setDiscardHandler(discard: () => void): void {
    this.discard = discard;
    this.scheduleDiscard();
  }

  retainDownload(): () => void {
    this.downloads++;
    this.retentionReason = "download";
    this.lastUsedAt = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.downloads--;
      this.retentionReason = this.presented ? "presented" : "recent-use";
      this.lastUsedAt = Date.now();
      this.scheduleDiscard();
    };
  }

  noteActivity(): void {
    this.lastUsedAt = Date.now();
    this.scheduleDiscard();
  }

  private scheduleDiscard(): void {
    clearTimeout(this.discardTimer);
    if (this.disposed || !this.discard || this.presented || this.leases > 0) return;
    this.discardTimer = setTimeout(
      () => {
        void this.discardIfExpired().catch((error) => {
          console.warn("[browser] Could not discard parked page", error);
          this.noteActivity();
        });
      },
      Math.max(1, this.lastUsedAt + PARKED_BROWSER_DISCARD_MS - Date.now()),
    );
    this.discardTimer.unref();
  }

  async discardIfExpired(now = Date.now()): Promise<boolean> {
    return this.queue.run(async () => {
      if (this.disposed || this.contents.isDestroyed() || !this.discard) return false;
      const reason = this.getRetentionReason(now);
      this.retentionReason = reason ?? "expired";
      if (reason) {
        if (reason !== "recent-use") this.lastUsedAt = now;
        this.scheduleDiscard();
        return false;
      }
      this.discard();
      this.released++;
      this.dispose();
      return true;
    });
  }

  private getRetentionReason(now: number): string | null {
    if (this.presented) return "presented";
    if (this.leases) return "automation";
    if (this.downloads) return "download";
    if (this.contents.isLoading()) return "loading";
    if (this.contents.isCurrentlyAudible?.()) return "audio";
    if (this.contents.isDevToolsOpened?.()) return "devtools";
    if (now - this.lastUsedAt < PARKED_BROWSER_DISCARD_MS) return "recent-use";
    return null;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.discardTimer);
    this.clearTimer();
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.disposed || this.presented || this.leases > 0 || this.frozen || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.setFrozen(true)
        .catch((error) => console.warn("[browser] Could not suspend parked page", error))
        .finally(() => this.schedule());
    }, PARKED_BROWSER_IDLE_MS);
    this.timer.unref();
  }

  private setFrozen(frozen: boolean): Promise<void> {
    return this.queue.run(async () => {
      if (this.disposed || this.contents.isDestroyed() || this.frozen === frozen) return;
      if (
        frozen &&
        (this.presented ||
          this.leases > 0 ||
          this.contents.isLoading() ||
          // Electron ignores freezing while frame production overrides throttling.
          !this.contents.getBackgroundThrottling() ||
          this.contents.isCurrentlyAudible?.() ||
          this.contents.isDevToolsOpened?.())
      )
        return;
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach("1.3");
      await this.contents.debugger.sendCommand("Page.setWebLifecycleState", {
        state: frozen ? "frozen" : "active",
      });
      this.frozen = frozen;
    });
  }
}
