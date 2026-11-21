import { z } from "zod";
import { execCommand } from "../utils/spawn.js";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  rss: number;
  name: string;
}

export function summarizeProcessTree(entries: ProcessEntry[], rootPid: number, limit = 10) {
  const children = new Map<number, ProcessEntry[]>();
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  for (const entry of entries) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const pending = [rootPid];
  const visited = new Set<number>();
  const descendants: ProcessEntry[] = [];
  while (pending.length) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (!entry) continue;
    descendants.push(entry);
    for (const child of children.get(pid) ?? []) pending.push(child.pid);
  }
  return {
    processCount: descendants.length,
    rss: descendants.reduce((total, entry) => total + entry.rss, 0),
    largest: descendants.sort((a, b) => b.rss - a.rss).slice(0, limit),
  };
}

const WindowsEntry = z.object({
  ProcessId: z.number(),
  ParentProcessId: z.number(),
  WorkingSetSize: z.union([z.number(), z.string().regex(/^\d+$/)]),
  Name: z.string(),
});

/** Samples process names and RSS only, never command arguments or heap contents. */
export async function collectProcessEntries(): Promise<ProcessEntry[]> {
  const commandOptions = { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 };
  let entries: ProcessEntry[];
  if (process.platform === "win32") {
    const { stdout } = await execCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name) | ConvertTo-Json -Compress",
      ],
      commandOptions,
    );
    const parsed: unknown = JSON.parse(stdout);
    entries = z
      .array(WindowsEntry)
      .parse(Array.isArray(parsed) ? parsed : [parsed])
      .map((entry) => ({
        pid: entry.ProcessId,
        ppid: entry.ParentProcessId,
        rss: Number(entry.WorkingSetSize),
        name: entry.Name,
      }));
  } else {
    const { stdout } = await execCommand("ps", ["-axo", "pid=,ppid=,rss=,ucomm="], commandOptions);
    entries = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rss: Number(match[3]) * 1024,
        name: match[4]!.trim(),
      });
    }
  }
  return entries;
}

export async function collectProcessTreeDiagnostics(options?: { includeAll?: boolean }) {
  const entries = await collectProcessEntries();
  const result = summarizeProcessTree(
    entries,
    process.pid,
    options?.includeAll ? entries.length : 10,
  );
  if (!result.processCount) throw new Error("Daemon missing from process snapshot");
  return result;
}
