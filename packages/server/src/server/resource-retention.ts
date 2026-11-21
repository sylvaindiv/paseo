import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { collectProcessEntries, type ProcessEntry } from "./process-tree-diagnostics.js";

export interface AgentMemory {
  id: string;
  bytes: number;
  tools: { name: string; bytes: number }[];
}

export interface ResourceMemorySample {
  at: string;
  totalBytes: number;
  daemonBytes: number;
  sharedBytes: number;
  unattributedBytes: number;
  agents: AgentMemory[];
}

interface MemoryOwner {
  id: string;
  pid: number | undefined;
}

export function attributeResourceMemory(
  entries: ProcessEntry[],
  daemonPid: number,
  owners: MemoryOwner[],
  browsers: ReadonlyMap<number, string>,
  at = new Date().toISOString(),
): ResourceMemorySample {
  const result: ResourceMemorySample = {
    at,
    totalBytes: 0,
    daemonBytes: 0,
    sharedBytes: 0,
    unattributedBytes: 0,
    agents: [],
  };
  const owned = new Map<number, string | null>();
  const agents = new Map<string, { bytes: number; tools: Map<string, number> }>();
  for (const { id, pid } of owners) {
    agents.set(id, { bytes: 0, tools: new Map() });
    if (pid) owned.set(pid, owned.has(pid) ? null : id);
  }
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  for (const entry of byPid.values()) {
    let ancestor: ProcessEntry | undefined = entry;
    const seen = new Set<number>();
    while (ancestor && !seen.has(ancestor.pid)) {
      const { pid } = ancestor;
      seen.add(pid);
      const id = owned.has(pid) ? owned.get(pid) : browsers.get(pid);
      if (id !== undefined) {
        result.totalBytes += entry.rss;
        const agent = id === null ? undefined : agents.get(id);
        if (agent) agent.bytes += entry.rss;
        if (agent && (entry.pid !== pid || browsers.has(pid))) {
          const name = basename(entry.name).slice(0, 80);
          agent.tools.set(name, (agent.tools.get(name) ?? 0) + entry.rss);
        }
        if (id === null) {
          result.sharedBytes += entry.rss;
        } else if (!agent) {
          result.unattributedBytes += entry.rss;
        }
        break;
      }
      if (pid === daemonPid) {
        result.totalBytes += entry.rss;
        if (entry.pid === daemonPid) result.daemonBytes += entry.rss;
        else result.unattributedBytes += entry.rss;
        break;
      }
      ancestor = byPid.get(ancestor.ppid);
    }
  }
  result.agents = [...agents]
    .map(([id, { bytes, tools }]) => ({
      id,
      bytes,
      tools: [...tools]
        .map(([name, toolBytes]) => ({ name, bytes: toolBytes }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return result;
}

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
  paseoHome: string;
  sweep(): Promise<Record<string, number>>;
  owners(): MemoryOwner[];
  publish(current: ResourceMemorySample, peak: ResourceMemorySample): void;
  reportError(error: unknown): void;
}): () => void {
  const log = new ResourceRetentionLog(input.file);
  let peak: ResourceMemorySample | undefined;
  let sessions: Record<string, number> | undefined;
  let sweeping = false;
  const sample = () => {
    if (!sweeping) {
      sweeping = true;
      void input
        .sweep()
        .then((counts) => {
          sessions = counts;
          return counts;
        })
        .catch(input.reportError)
        .finally(() => {
          sweeping = false;
        });
    }
    void log
      .sample(async () => {
        const [processes, browsers] = await Promise.all([
          collectProcessEntries(),
          import("./browser-resource-service.js")
            .then(({ readOwnedBrowserPids }) => readOwnedBrowserPids(input.paseoHome))
            .catch(() => new Map<number, string>()),
        ]);
        if (!processes.some(({ pid }) => pid === process.pid)) {
          throw new Error("Daemon missing from process snapshot");
        }
        const memory = attributeResourceMemory(processes, process.pid, input.owners(), browsers);
        if (!peak || memory.totalBytes > peak.totalBytes) peak = memory;
        input.publish(memory, peak);
        return { memory, peak, sessions };
      })
      .catch(input.reportError);
  };
  sample();
  const timer = setInterval(sample, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
