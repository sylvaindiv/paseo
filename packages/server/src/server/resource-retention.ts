import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const SEGMENT_BYTES = 5 * 1024 * 1024;

/** Two segments cap local samples at 10 MiB; writes never accumulate behind a slow sampler. */
export class ResourceRetentionLog {
  private busy = false;
  constructor(private readonly file: string) {}

  async sample(read: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sample =
        JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          memory: process.memoryUsage(),
          resources: await read(),
        }) + "\n";
      if (Buffer.byteLength(sample) > SEGMENT_BYTES) return;
      await mkdir(dirname(this.file), { recursive: true });
      const size = await stat(this.file).then(
        (info) => info.size,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      if (size + Buffer.byteLength(sample) > SEGMENT_BYTES)
        await rename(this.file, `${this.file}.1`);
      await appendFile(this.file, sample, { mode: 0o600 });
    } finally {
      this.busy = false;
    }
  }
}

export function startResourceRetention(input: {
  file: string;
  sweep(): Promise<Record<string, number>>;
  reportError(error: unknown): void;
}): () => void {
  const log = new ResourceRetentionLog(input.file);
  const sample = () => {
    void log
      .sample(async () => ({
        sessions: await input.sweep(),
        processes: await import("./process-tree-diagnostics.js").then((module) =>
          module.collectProcessTreeDiagnostics({ includeAll: true }),
        ),
      }))
      .catch(input.reportError);
  };
  const timer = setInterval(sample, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
