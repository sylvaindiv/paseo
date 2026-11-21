import { getPaseoClient } from "@getpaseo/plugin/client";
import { batchLabel, type BatchObservation, type ProjectBatch } from "../shared/project-todos.js";

type Agent = ReturnType<ReturnType<typeof getPaseoClient>["agents"]["ref"]>;
type Snapshot = NonNullable<ReturnType<Agent["current"]>>;
export type RecordObservation = (
  id: string,
  state: BatchObservation,
  turnId?: string,
) => Promise<ProjectBatch | undefined>;

export function createBatchTracking() {
  const watched = new Map<string, () => void>();

  function stop(id: string) {
    watched.get(id)?.();
    watched.delete(id);
  }

  function watch(batch: ProjectBatch, record: RecordObservation) {
    if (watched.has(batch.id)) return;
    const id = batch.id;
    let state = batch.state;
    let turnId = batch.turnId;
    let savedTurn = batch.turnId;
    let subscription: ReturnType<Agent["timeline"]["subscribe"]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let recording = Promise.resolve();

    async function save(previous: Promise<void>, next: BatchObservation, observedTurn?: string) {
      await previous;
      if (disposed || (state === next && savedTurn === observedTurn)) return;
      const saved = await record(id, next, observedTurn);
      if (!saved || saved.state === "review" || saved.state === "failed") {
        stop(id);
        return;
      }
      state = saved.state;
      savedTurn = saved.turnId;
      turnId = savedTurn ?? turnId;
    }

    const observe = (next: BatchObservation, observedTurn = turnId) => {
      if (disposed || (turnId && observedTurn !== turnId)) return;
      turnId ??= observedTurn;
      recording = save(recording, next, observedTurn).catch(() => {
        // The next snapshot or live event can repeat the observation after reconnecting.
      });
    };

    const attach = (agent: Agent) => {
      if (subscription) return;
      const live = agent.timeline.subscribe(({ event }) => {
        if (
          event.type === "timeline" &&
          event.item.type === "user_message" &&
          event.item.clientMessageId === id &&
          event.turnId
        ) {
          observe("running", event.turnId);
        } else if (turnId && "turnId" in event && event.turnId === turnId) {
          if (event.type === "turn_completed") observe("review", turnId);
          if (event.type === "turn_failed" || event.type === "turn_canceled")
            observe("failed", turnId);
        }
      });
      subscription = live;
      void live.ready.catch(() => {
        if (subscription === live) subscription = undefined;
        live();
      });
    };

    async function poll() {
      try {
        const agent = getPaseoClient(batch.destination.serverId).agents.ref(id);
        const snapshot = (await agent.refresh())?.agent;
        if (disposed) return;
        if (snapshot?.labels[batchLabel] === id) {
          attach(agent);
          const result = await inspectFirstTurn(agent, snapshot, id, turnId);
          if (state === "launching" && result.state === "unknown") {
            if (!result.turnId) return;
            observe("running", result.turnId);
          }
          observe(result.state, result.turnId);
        } else if (state !== "launching") {
          observe("unknown");
        }
      } catch {
        if (state !== "launching") observe("unknown");
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 6_000);
      }
    }

    watched.set(id, () => {
      disposed = true;
      clearTimeout(timer);
      subscription?.();
    });
    void poll();
  }

  return { watch, stop, dispose: () => [...watched.keys()].forEach(stop) };
}

async function inspectFirstTurn(agent: Agent, snapshot: Snapshot, id: string, turnId?: string) {
  const initial =
    !turnId || snapshot.status === "error" ? await findInitialTurn(agent, id) : undefined;
  const original = turnId ?? initial?.turnId;
  let state: BatchObservation = "unknown";
  if (original) {
    if (snapshot.lastCompletedTurnId === original) state = "review";
    else if (snapshot.activeTurn?.turnId === original) state = "running";
    else if (snapshot.status === "error" && initial?.isLatest) state = "failed";
  }
  return { state, turnId: original };
}

async function findInitialTurn(agent: Agent, id: string) {
  let cursor:
    | NonNullable<Awaited<ReturnType<Agent["timeline"]["refetch"]>>["startCursor"]>
    | undefined;
  let isLatest = true;
  // The original prompt anchors recovery to its turn even if the agent has received follow-ups.
  for (let page = 0; page < 10; page++) {
    const timeline = await agent.timeline.refetch({
      projection: "canonical",
      limit: 100,
      ...(cursor ? { direction: "before", cursor } : { direction: "tail" }),
    });
    if (timeline.error) return;
    for (const entry of timeline.entries.toReversed()) {
      if (entry.item.type !== "user_message") continue;
      if (entry.item.clientMessageId === id && entry.turnId)
        return { turnId: entry.turnId, isLatest };
      isLatest = false;
    }
    if (!timeline.hasOlder || !timeline.startCursor) return;
    cursor = timeline.startCursor;
  }
}

export async function launchBatch(batch: ProjectBatch, record: RecordObservation) {
  const { id, destination } = batch;
  const api = getPaseoClient(destination.serverId);
  let initial: Snapshot | undefined;
  let rejected = false;
  let agent: Agent;
  try {
    agent = await api.workspaces.ref(destination.workspaceId).agents.create({
      config: { provider: destination.providerModel },
      prompt: batch.prompt,
      title: batch.title,
      agentId: id,
      idempotencyKey: id,
      clientMessageId: id,
      labels: { [batchLabel]: id },
      onEvent: (event) => {
        if (event.phase === "prompt_started") initial = event.agent;
        if (event.phase === "failed" && !event.outcomeUnknown && event.failedStage) rejected = true;
      },
    });
  } catch (error) {
    if (rejected) {
      await record(id, "failed", initial?.activeTurn?.turnId);
      return;
    }
    throw error;
  }
  const snapshot = agent.current();
  const turnId =
    initial?.activeTurn?.turnId ??
    initial?.lastCompletedTurnId ??
    (await findInitialTurn(agent, id).catch(() => undefined))?.turnId;
  if (turnId && snapshot?.lastCompletedTurnId === turnId) await record(id, "review", turnId);
  else await record(id, "running", turnId);
}
