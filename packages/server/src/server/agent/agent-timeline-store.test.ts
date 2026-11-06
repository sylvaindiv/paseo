import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });
});

describe("projected timeline retention", () => {
  it("retains one full tool state while streaming every source update", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent");
    for (let seq = 1; seq <= 2000; seq++) {
      const item = {
        type: "tool_call" as const,
        callId: "child",
        name: "task",
        status: "running" as const,
        error: null,
        detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
      };
      expect(store.append("agent", item)).toMatchObject({ seq, item });
    }
    const result = store.fetch("agent", { limit: 0 });
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
    expect(result.window.maxSeq).toBe(2000);
  });

  it("catches up a mid-message cursor with the complete projected message", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "e" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "A" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "B" });
    expect(
      store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } }).rows,
    ).toMatchObject([
      {
        item: { text: "AB" },
        seqStart: 1,
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      },
    ]);
  });
});

describe("projected sequence ownership", () => {
  it("preserves fetched coverage when another source chunk arrives", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", text: "A" });
    const before = store.fetch("a");
    store.append("a", { type: "assistant_message", text: "B" });
    expect(before.rows[0]).toMatchObject({
      item: { text: "A" },
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    });
    expect(store.fetch("a").rows[0]).toMatchObject({
      item: { text: "AB" },
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    });
  });
  it("preserves source positions when seeding a projected history whose last update is an earlier tool", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    const tool = {
      type: "tool_call" as const,
      callId: "t",
      name: "shell",
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    store.append("a", { ...tool, status: "running" });
    store.append("a", { type: "assistant_message", text: "Answer" });
    store.append("a", { ...tool, status: "completed" });
    store.initialize("b", { rows: store.getRows("a") });
    expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
    expect(store.fetch("b").rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
  });
  it("returns the last projected assistant message without joining different messages", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
    expect(store.getLastAssistantMessage("a")).toBe("Second");
  });
});

it("includes transitive tool updates in a contiguous projected tail", () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a");
  const tool = (callId: string, status: "running" | "completed") => ({
    type: "tool_call" as const,
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "plain_text" as const, label: "work" },
  });
  store.append("a", tool("first", "running"));
  store.append("a", tool("second", "running"));
  store.append("a", { type: "user_message", text: "Continue" });
  store.append("a", tool("first", "completed"));
  store.append("a", { type: "assistant_message", text: "Answer" });
  store.append("a", tool("second", "completed"));
  const tail = store.fetch("a", { limit: 1 });
  expect(tail.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 5]);
  expect(tail).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false });
});

it("pages a long transcript without changing older history or projected counts", () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a", { epoch: "stable" });
  for (let seq = 1; seq <= 2_000; seq++) {
    store.append("a", { type: "user_message", text: `Prompt ${seq}`, messageId: `${seq}` });
  }
  const tail = store.fetch("a", { limit: 40 });
  expect(store.getItemCount("a")).toBe(2_000);
  expect(tail.rows).toHaveLength(40);
  expect(tail).toMatchObject({ startSeq: 1961, endSeq: 2000, hasOlder: true });
  const before = store.fetch("a", {
    direction: "before",
    cursor: { epoch: "stable", seq: tail.startSeq! },
    limit: 40,
  });
  expect(before.rows.map((row) => row.seq)).toEqual(
    Array.from({ length: 40 }, (_, index) => 1921 + index),
  );
  tail.rows[0].seq = 0;
  expect(store.fetch("a", { limit: 40 }).rows[0].seq).toBe(1961);
  expect(store.getLastItem("a")).toMatchObject({ text: "Prompt 2000" });
  expect(store.fetch("a", { limit: 0 }).rows).toHaveLength(2_000);
});

it("offloads complete history and restores the same epoch, approvals and anchors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-timeline-"));
  try {
    const store = new InMemoryAgentTimelineStore(directory);
    store.initialize("a", { epoch: "stable" });
    store.append("a", { type: "user_message", text: "Build", clientMessageId: "client" });
    store.enrichSubmittedUserMessage("a", "client", "provider");
    store.append(
      "a",
      {
        type: "tool_call",
        callId: "approval",
        name: "ExitPlanMode",
        metadata: { approval: { decision: "approved", permissionId: "permission" } },
        providerSpecific: { preserved: true },
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: "Plan", text: "Preserve the proposal" },
      },
      { turnId: "turn-1" },
    );
    store.append("a", { type: "error", message: "Paseo-only error" });
    store.append("a", { type: "assistant_message", text: "Done", messageId: "done" });
    const before = store.fetch("a", { limit: 0 });
    expect(await store.offload("a")).toBe(true);
    expect(store.has("a")).toBe(true);
    expect(store.isResident("a")).toBe(false);
    await store.restore("a");
    expect(store.isResident("a")).toBe(true);
    expect(store.fetch("a", { limit: 0 })).toEqual(before);
    expect(store.append("a", { type: "user_message", text: "Continue" }).seq).toBe(5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps history in memory when its snapshot cannot be written or becomes stale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-timeline-"));
  try {
    const invalidDirectory = join(directory, "file");
    await writeFile(invalidDirectory, "occupied");
    const failing = new InMemoryAgentTimelineStore(invalidDirectory);
    failing.initialize("a", { items: [{ type: "error", message: "Keep me" }] });
    await expect(failing.offload("a")).rejects.toThrow();
    expect(failing.getItems("a")).toEqual([{ type: "error", message: "Keep me" }]);

    const store = new InMemoryAgentTimelineStore(directory);
    store.initialize("a", { epoch: "stable" });
    store.append("a", { type: "user_message", text: "First" });
    const offload = store.offload("a");
    store.append("a", { type: "user_message", text: "Second" });
    expect(await offload).toBe(false);
    expect(store.getItemCount("a")).toBe(2);
    expect(store.isResident("a")).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("waits for an old snapshot deletion before offloading a reopened conversation again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-timeline-"));
  let releaseDelete!: () => void;
  let startedDelete!: () => void;
  const deleting = new Promise<void>((resolve) => {
    startedDelete = resolve;
  });
  const deletionAllowed = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const store = new InMemoryAgentTimelineStore(directory, async (path) => {
    startedDelete();
    await deletionAllowed;
    await rm(path, { force: true });
  });
  try {
    store.initialize("a", { epoch: "stable", items: [{ type: "user_message", text: "First" }] });
    await store.offload("a");
    await store.restore("a");
    await deleting;
    store.append("a", { type: "user_message", text: "Second" });
    const nextOffload = store.offload("a");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.isResident("a")).toBe(true);
    releaseDelete();
    expect(await nextOffload).toBe(true);
    await store.restore("a");
    expect(store.getItems("a")).toEqual([
      { type: "user_message", text: "First" },
      { type: "user_message", text: "Second" },
    ]);
  } finally {
    releaseDelete();
    await rm(directory, { recursive: true, force: true });
  }
});
