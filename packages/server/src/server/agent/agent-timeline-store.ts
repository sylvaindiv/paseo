import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { TimelineProjection, type ProjectedTimelineRow } from "./timeline-projection.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
  revision: number;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
const TimelineSnapshotSchema = z.object({
  epoch: z.string(),
  nextSeq: z.number().int().positive(),
  rows: z.array(
    z.object({
      seq: z.number().int().positive(),
      timestamp: z.string(),
      // Validate the known shape without stripping provider-specific tool fields.
      item: z.custom<AgentTimelineItem>(
        (value) => AgentTimelineItemPayloadSchema.safeParse(value).success,
      ),
      turnId: z.string().optional(),
      providerMessageId: z.string().optional(),
      seqStart: z.number().int().positive(),
      seqEnd: z.number().int().positive(),
      sourceSeqRanges: z.array(
        z.object({ startSeq: z.number().int().positive(), endSeq: z.number().int().positive() }),
      ),
      collapsed: z.array(
        z.enum(["assistant_merge", "reasoning_merge", "tool_lifecycle", "identity"]),
      ),
    }),
  ),
});
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();
  private readonly coldSnapshots = new Map<string, { path: string }>();

  private readonly snapshotDeletes = new Map<string, Promise<void>>();

  constructor(
    private readonly snapshotDirectory?: string,
    private readonly removeSnapshot: (path: string) => Promise<void> = async (path) => {
      await rm(path, { force: true });
    },
  ) {}

  /** Call only after the provider runtime has closed and its events have drained. */
  async offload(agentId: string): Promise<boolean> {
    const state = this.states.get(agentId);
    if (!state || !this.snapshotDirectory) return false;
    const revision = state.revision;
    const snapshot = {
      epoch: state.epoch,
      nextSeq: state.nextSeq,
      rows: state.projection.getRows(),
    };
    // One file per agent also replaces snapshots left by a previous daemon crash.
    // Runtime closure and registration serialize access to this agent's snapshot.
    const key = createHash("sha256").update(agentId).digest("hex");
    const path = join(this.snapshotDirectory, `${key}.json`);
    // Restore releases its old file asynchronously. Its unlink must settle before
    // this generation writes the same agent's snapshot path again.
    await this.snapshotDeletes.get(path);
    await writeJsonFileAtomic(path, snapshot);
    if (this.states.get(agentId) !== state || state.revision !== revision) {
      await rm(path, { force: true });
      return false;
    }
    this.coldSnapshots.set(agentId, { path });
    this.states.delete(agentId);
    return true;
  }

  async restore(agentId: string): Promise<void> {
    const cold = this.coldSnapshots.get(agentId);
    if (!cold) return;
    const snapshot = TimelineSnapshotSchema.parse(JSON.parse(await readFile(cold.path, "utf8")));
    // Do not replace a newer timeline installed while the disk read was pending.
    if (this.coldSnapshots.get(agentId) !== cold) return;
    this.initialize(agentId, snapshot);
  }

  isResident(agentId: string): boolean {
    return this.states.has(agentId);
  }

  has(agentId: string): boolean {
    return this.states.has(agentId) || this.coldSnapshots.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    this.deleteColdSnapshot(agentId);
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const projection = new TimelineProjection();
    for (const row of rows) projection.append(row);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      minSeq: projection.minSeq,
      nextSeq,
      revision: 0,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
    this.deleteColdSnapshot(agentId);
  }

  private deleteColdSnapshot(agentId: string): void {
    const cold = this.coldSnapshots.get(agentId);
    this.coldSnapshots.delete(agentId);
    if (!cold) return;
    const removal = this.removeSnapshot(cold.path).catch(() => undefined);
    this.snapshotDeletes.set(cold.path, removal);
    void removal.then(() => {
      if (this.snapshotDeletes.get(cold.path) === removal) this.snapshotDeletes.delete(cold.path);
      return undefined;
    });
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId).projection.getItems();
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows();
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId).projection.findRow(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    const state = this.requireState(agentId);
    const row = state.projection.enrichSubmittedUserMessage(clientMessageId, providerMessageId);
    if (row) state.revision += 1;
    return row;
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;

    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      state.projection.count > 0 &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = state.projection.selectPage({
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    state.revision += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.findRow((row) => row.seqEnd === state.nextSeq - 1)?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    return this.requireState(agentId).projection.getLastAssistantMessage();
  }

  getItemCount(agentId: string): number {
    return this.requireState(agentId).projection.count;
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
