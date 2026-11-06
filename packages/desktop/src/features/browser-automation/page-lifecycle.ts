import { CdpSessionQueue } from "./cdp-session-queue.js";

export const PARKED_BROWSER_IDLE_MS = 60_000;

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

/** Freeze retains the document, forms and history; never discard a resident guest. */
export class BrowserPageLifecycle {
  private presented = true;
  private frozen = false;
  private leases = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly contents: PageContents,
    private readonly queue: CdpSessionQueue,
  ) {}

  async setPresented(presented: boolean): Promise<void> {
    this.presented = presented;
    this.clearTimer();
    if (presented) await this.setFrozen(false);
    else this.schedule();
  }

  async withAutomation<T>(task: () => Promise<T>): Promise<T> {
    // Acquire synchronously, before any queued freeze can run.
    this.leases++;
    this.clearTimer();
    try {
      await this.setFrozen(false);
      return await task();
    } finally {
      this.leases--;
      this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
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
