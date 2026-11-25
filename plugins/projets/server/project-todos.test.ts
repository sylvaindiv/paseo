import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openProjectTodoStore } from "./project-todos.js";
import {
  sequenceActivity,
  sequenceAssociation,
  sequenceTracking,
  type SequenceRun,
} from "../shared/sequence.js";
import { registerSequenceTracking } from "./sequence-tracking.js";
import { agentPrompt } from "../shared/agent-prompt.js";

let directory: string;
let store: ReturnType<typeof openProjectTodoStore>;
let filename: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-project-todos-"));
  filename = path.join(directory, "projects-todos.sqlite3");
  store = openProjectTodoStore(filename);
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("each project has its own list with durable titles and subtasks", () => {
  expect(store.read("a")).toEqual({
    phases: [{ id: "default", name: "Phase 1", order: 0 }],
    tasks: [],
  });
  store.write("a", { operation: "add", taskId: "t1", title: "Relire le brief" });
  store.write("b", { operation: "add", taskId: "t2", title: "Autre projet" });
  store.write("a", {
    operation: "subtask-add",
    taskId: "t1",
    subtaskId: "s1",
    title: "Vérifier les liens",
  });
  store.write("a", {
    operation: "subtask-add",
    taskId: "t1",
    subtaskId: "s1",
    title: "Rejouer la création",
  });
  expect(() =>
    store.write("b", {
      operation: "subtask-update",
      taskId: "t1",
      subtaskId: "s1",
      completed: true,
    }),
  ).toThrow();
  store.write("a", { operation: "update", taskId: "t1", title: "Relire le brief final" });
  store.write("a", {
    operation: "subtask-update",
    taskId: "t1",
    subtaskId: "s1",
    completed: true,
  });
  store.close();
  store = openProjectTodoStore(filename);
  const batch = store.read("a").tasks;
  expect(batch).toEqual([
    {
      id: "t1",
      title: "Relire le brief final",
      description: null,
      stage: null,
      completed: false,
      order: 0,
      subtasks: [{ id: "s1", title: "Vérifier les liens", completed: true }],
    },
  ]);
  expect(agentPrompt("Atlas", batch)).toContain("   - [x] Vérifier les liens");
  expect(store.read("b").tasks.map((task) => task.title)).toEqual(["Autre projet"]);
  store.write("a", { operation: "delete", taskId: "t1" });
  expect(store.read("a").tasks).toEqual([]);
});

test("overview reads phase counts in board order without changing the lists", () => {
  store.write("active", { operation: "phase-add", phaseId: "review", title: "Review" });
  store.write("active", { operation: "phase-status", phaseId: "review", status: "EN COURS" });
  store.write("active", { operation: "add", taskId: "a", title: "First" });
  store.write("active", { operation: "add", taskId: "b", title: "Second", phaseId: "review" });
  store.write("active", { operation: "update", taskId: "b", completed: true });
  store.write("active", { operation: "phase-reorder", phaseId: "review", overPhaseId: "default" });

  const before = store.read("active");
  expect(store.readOverview(["empty", "active"])).toEqual([
    {
      projectKey: "empty",
      phases: [{ id: "default", name: "Phase 1", status: null, completed: 0, total: 0 }],
    },
    {
      projectKey: "active",
      phases: [
        { id: "review", name: "Review", status: "EN COURS", completed: 1, total: 1 },
        { id: "default", name: "Phase 1", status: null, completed: 0, total: 1 },
      ],
    },
  ]);
  expect(store.read("active")).toEqual(before);
  store.importProject("empty", store.read("empty"));
});

test("reordering a subset preserves other task positions and rejects IDs from another list", () => {
  for (const id of ["first", "between", "last"])
    store.write("a", { operation: "add", taskId: id, title: id });
  store.write("b", { operation: "add", taskId: "foreign", title: "Other list" });
  store.write("a", { operation: "reorder", ids: ["last", "first"] });
  expect(() => store.write("a", { operation: "reorder", ids: ["last", "foreign"] })).toThrow();
  expect(store.read("a").tasks.map((task) => task.id)).toEqual(["last", "between", "first"]);
});

test("a one-time import preserves phase metadata and never overwrites an existing project", () => {
  const imported = {
    phases: [{ id: "review", name: "Review", order: 12, status: "EN COURS" }],
    tasks: [
      {
        id: "t",
        title: "Task",
        description: "Note",
        stage: "Review",
        completed: false,
        order: 8,
        subtasks: [{ id: "s", title: "Child", completed: true }],
      },
    ],
  };
  store.importProject("a", imported);
  expect(store.read("a")).toEqual(imported);
  expect(() => store.importProject("a", { ...imported, tasks: [] })).toThrow();
  expect(store.read("a")).toEqual(imported);
});

test("phase edits keep task and subtask identity, including completed tasks, within the list", () => {
  for (const list of ["a", "b"]) {
    store.write(list, { operation: "phase-add", phaseId: "review", title: "Recette" });
    store.write(list, { operation: "add", taskId: list, title: "Relire", phaseId: "review" });
  }
  store.write("a", { operation: "add", taskId: "legacy", title: "Ancienne tâche" });
  store.write("a", {
    operation: "subtask-add",
    taskId: "a",
    subtaskId: "s",
    title: "Vérifier",
  });
  store.write("a", { operation: "update", taskId: "a", completed: true });
  expect(() =>
    store.write("a", { operation: "phase-rename", phaseId: "review", title: "Phase 1" }),
  ).toThrow();
  store.write("a", { operation: "phase-rename", phaseId: "review", title: "Validation" });
  store.write("a", { operation: "phase-status", phaseId: "review", status: "EN COURS" });
  const atlas = store.read("a");
  const boreal = store.read("b");
  expect(atlas?.phases[1]).toMatchObject({ id: "review", name: "Validation", status: "EN COURS" });
  expect(boreal?.phases[1]?.name).toBe("Recette");
  const tasks = store.read("a").tasks;
  expect(tasks[0]).toMatchObject({
    id: "a",
    stage: "Validation",
    completed: true,
    subtasks: [{ id: "s" }],
  });
  store.write("a", { operation: "phase-move", taskId: "a", phaseId: "default" });
  expect(store.read("a").tasks.find((task) => task.id === "a")).toMatchObject({
    stage: "Phase 1",
    subtasks: [{ id: "s" }],
  });
  expect(() =>
    store.write("a", { operation: "phase-move", taskId: "b", phaseId: "review" }),
  ).toThrow();
  store.write("a", { operation: "phase-move", taskId: "a", phaseId: "review" });
  store.write("a", { operation: "phase-delete", phaseId: "review" });
  expect(store.read("a").tasks.find((task) => task.id === "a")).toMatchObject({
    stage: "Phase 1",
    completed: true,
  });
  expect(store.read("b").tasks[0]?.stage).toBe("Recette");
});

test("inserting below a task and moving across phases preserve the target order and subtasks", () => {
  store.write("a", { operation: "phase-add", phaseId: "review", title: "Review" });
  for (const id of ["one", "two", "three"]) {
    store.write("a", { operation: "add", taskId: id, title: id, phaseId: "review" });
  }
  store.write("a", {
    operation: "add",
    taskId: "below",
    title: "Below",
    phaseId: "review",
    afterTaskId: "one",
  });
  expect(store.read("a").tasks.map((task) => task.id)).toEqual(["one", "below", "two", "three"]);
  store.write("a", { operation: "subtask-add", taskId: "one", subtaskId: "child", title: "Child" });
  store.write("a", { operation: "phase-move", taskId: "one", phaseId: "default" });
  store.write("a", { operation: "phase-move", taskId: "one", phaseId: "review" });
  expect(store.read("a").tasks.map((task) => task.id)).toEqual(["below", "two", "three", "one"]);
  expect(store.read("a").tasks.at(-1)).toMatchObject({
    stage: "Review",
    subtasks: [{ id: "child" }],
  });
});

test("Sensei editor notes, task states and subtask order survive reload and duplication", () => {
  store.write("a", { operation: "add", taskId: "task", title: "Livraison" });
  store.write("a", {
    operation: "update",
    taskId: "task",
    description: "Notes\nDeuxième ligne",
    status: "doing",
  });
  for (const id of ["first", "second"]) {
    store.write("a", { operation: "subtask-add", taskId: "task", subtaskId: id, title: id });
  }
  store.write("a", {
    operation: "subtask-move",
    taskId: "task",
    subtaskId: "second",
    direction: -1,
  });
  store.close();
  store = openProjectTodoStore(filename);
  expect(store.read("a").tasks[0]).toMatchObject({
    completed: false,
    status: "doing",
    description: "Notes\nDeuxième ligne",
    subtasks: [{ id: "second" }, { id: "first" }],
  });
  store.write("a", { operation: "update", taskId: "task", status: "done" });
  expect(store.read("a").tasks[0]).toMatchObject({ completed: true, status: "done" });
  store.write("a", { operation: "duplicate", taskId: "task", copyId: "copy" });
  store.write("a", { operation: "duplicate", taskId: "task", copyId: "copy" });
  expect(store.read("a").tasks.map((task) => task.id)).toEqual(["task", "copy"]);
  expect(store.read("a").tasks[1]).toMatchObject({
    title: "Livraison (copie)",
    completed: false,
    description: "Notes\nDeuxième ligne",
    subtasks: [
      { title: "second", completed: false },
      { title: "first", completed: false },
    ],
  });
  store.write("a", { operation: "update", taskId: "task", status: "todo" });
  expect(store.read("a").tasks[0]).toMatchObject({ completed: false, status: "todo" });
});

test("reordering phases keeps the tasks that previously fell back to Phase 1", () => {
  store.write("a", { operation: "phase-add", phaseId: "review", title: "Review" });
  store.write("a", { operation: "add", taskId: "first", title: "Old task" });
  store.write("a", { operation: "add", taskId: "second", title: "Review task", phaseId: "review" });
  expect(() =>
    store.write("a", { operation: "phase-reorder", phaseId: "foreign", overPhaseId: "default" }),
  ).toThrow();
  store.write("a", { operation: "phase-reorder", phaseId: "review", overPhaseId: "default" });
  store.close();
  store = openProjectTodoStore(filename);
  expect(store.read("a").phases.map((phase) => [phase.id, phase.order])).toEqual([
    ["review", 0],
    ["default", 1],
  ]);
  expect(store.read("a").tasks.map((task) => [task.id, task.stage])).toEqual([
    ["first", "Phase 1"],
    ["second", "Review"],
  ]);
});

test("legacy selections are imported once and reservation prevents duplicate or overlapping lots", () => {
  for (const id of ["one", "two", "three"])
    store.write("a", { operation: "add", taskId: id, title: id });
  store.write("a", { operation: "update", taskId: "one", description: "Notes" });
  store.write("a", { operation: "queue-import", taskIds: ["two", "one", "two", "missing"] });
  const destination = { serverId: "host", workspaceId: "space", providerModel: "mock/model" };
  const reserve = {
    operation: "batch-reserve",
    batchId: "lot-1",
    taskIds: ["two", "one"],
    projectName: "Atlas",
    destination,
  } as const;
  store.write("a", { ...reserve, taskIds: [...reserve.taskIds] });
  expect(() => store.write("a", { ...reserve, batchId: "duplicate", taskIds: ["one"] })).toThrow();
  store.close();
  store = openProjectTodoStore(filename);
  store.write("a", { ...reserve, taskIds: [...reserve.taskIds] });
  expect(store.read("a").dispatch?.batches).toEqual([
    expect.objectContaining({
      id: "lot-1",
      state: "launching",
      prompt: expect.stringContaining("1. two\n2. one\n   Notes"),
    }),
  ]);
  store.write("a", {
    operation: "batch-observe",
    batchId: "lot-1",
    state: "running",
    turnId: "first",
  });
  store.write("a", { operation: "queue-import", taskIds: ["two", "three"] });
  store.write("a", { operation: "queue-task", taskId: "three", queued: true });
  store.write("a", { ...reserve, batchId: "lot-2", taskIds: ["three"] });
  expect(store.read("a").dispatch?.batches.map(({ id, state }) => [id, state])).toEqual([
    ["lot-1", "running"],
    ["lot-2", "launching"],
  ]);
  expect(store.read("a").dispatch?.queue).toEqual(["three"]);
});

test("only the initial turn settles a lot and unsuccessful tasks can be requeued", () => {
  for (const taskId of ["review", "retry"]) {
    store.write("a", { operation: "add", taskId, title: taskId });
    store.write("a", { operation: "queue-task", taskId, queued: true });
    store.write("a", {
      operation: "batch-reserve",
      batchId: taskId,
      taskIds: [taskId],
      projectName: "Atlas",
      destination: { serverId: "host", workspaceId: "space", providerModel: "mock/model" },
    });
    store.observeAgent(taskId, "running", "first");
  }
  store.close();
  store = openProjectTodoStore(filename);
  store.observeAgent("review", "unknown", "first");
  expect(store.read("a").dispatch?.batches[0]?.state).toBe("unknown");
  store.observeAgent("review", "running", "first");
  store.observeAgent("review", "review", "later");
  expect(store.read("a").dispatch?.batches[0]?.state).toBe("running");
  store.observeAgent("review", "review", "first");
  store.observeAgent("review", "failed", "first");
  store.observeAgent("retry", "failed", "first");
  expect(store.read("a").dispatch?.batches.map((batch) => batch.state)).toEqual([
    "review",
    "failed",
  ]);
  store.write("a", { operation: "batch-requeue", batchId: "retry" });
  store.write("a", { operation: "update", taskId: "review", completed: true });
  expect(store.read("a").dispatch).toMatchObject({ queue: ["retry"], batches: [] });
  expect(store.read("a").tasks[0]).toMatchObject({ id: "review", completed: true, stage: null });
});

test("Things merges independent fields and retains both versions of a conflicting title", async () => {
  const { pullThings } = await import("./things-sync.js");
  const p = { id: "p:1", kind: "project" as const, parent: null, title: "Projet", done: false };
  const t = {
    id: "t:1",
    kind: "task" as const,
    parent: p.id,
    title: "Base",
    notes: "",
    done: false,
  };
  const state: Parameters<typeof pullThings>[0] = {
    rows: { [p.id]: p, [t.id]: { ...t, title: "Paseo" } },
    base: { [p.id]: p, [t.id]: t },
    links: {},
    detached: [],
    conflicts: [],
    pending: {},
    area: "scope",
  };
  pullThings(state, { [p.id]: p, [t.id]: { ...t, notes: "Things", done: true } });
  expect(state.rows[t.id]).toEqual({ ...t, title: "Paseo", notes: "Things", done: true });
  pullThings(state, { [p.id]: p, [t.id]: { ...t, title: "Renommé", notes: "Things", done: true } });
  expect(state.conflicts).toMatchObject([{ field: "title", paseo: "Paseo", things: "Renommé" }]);
  pullThings(state, {});
  expect(state.detached).toEqual([p.id]);
  expect(state.rows[t.id]?.title).toBe("Paseo");
});

test("manual reordering produces no Things edits", async () => {
  const { diffRows } = await import("../shared/things.js");
  const a = { id: "a", kind: "child" as const, parent: "t", title: "A", done: true };
  const b = { ...a, id: "b", title: "B", done: false };
  expect(diffRows({ a, b }, { b, a })).toEqual([]);
});

test("Sequence routes only to the linked project and persists tracking across reloads", async () => {
  type TrackingInput = ReturnType<typeof sequenceTracking.input.parse>;
  type LinkInput = ReturnType<typeof sequenceAssociation.input.parse>;
  const context = {
    paseo: {
      workspaces: {
        ref: (id: string) => ({
          refresh: async () => ({
            projectId: id === "test-workspace" ? "paseo-project" : "other-project",
          }),
        }),
      },
    },
  };
  let activity: () => ReturnType<typeof sequenceActivity.output.parse> = () => [];
  let link: (input: LinkInput) => string | null = () => null;
  let tracking: (
    input: TrackingInput,
    options: typeof context,
  ) => Promise<SequenceRun | null> = async () => null;
  const server = {
    handle(rpc: { name: string }, handler: unknown) {
      if (rpc.name === sequenceActivity.name) activity = handler as typeof activity;
      else if (rpc.name === sequenceAssociation.name) link = handler as typeof link;
      else tracking = handler as typeof tracking;
    },
    on() {
      return () => {};
    },
  } as unknown as PluginServerContext;
  const handle = (input: TrackingInput) => tracking(input, context);
  const project = "things-project";
  const task = "things-local-task";
  const run: SequenceRun = {
    id: "test-batch",
    taskIds: [],
    title: "Préparer le pinceau",
    prompt: "Préparer le pinceau",
    state: "launching",
    destination: {
      serverId: "test-host",
      workspaceId: "test-workspace",
      providerModel: "test/model",
    },
    profile: { id: "test-profile" },
    images: [],
  };
  let stop = registerSequenceTracking(server, directory);
  try {
    const reserve = { action: "reserve" as const, task, project, run };
    await expect(handle(reserve)).rejects.toThrow("projet associé");
    expect(link({ action: "write", project, destination: "paseo-project" })).toBe("paseo-project");
    await expect(
      handle({
        ...reserve,
        run: { ...run, destination: { ...run.destination, workspaceId: "unrelated" } },
      }),
    ).rejects.toThrow("projet associé");
    await expect(handle(reserve)).resolves.toMatchObject({ taskIds: [task] });
    expect(activity()).toEqual([]);
    await expect(handle(reserve)).rejects.toThrow("déjà été confiée");
    await expect(
      handle({ action: "observe", task, id: run.id, state: "running", turnId: "first" }),
    ).resolves.toMatchObject({ state: "running" });
    await expect(
      handle({ action: "observe", task, id: run.id, state: "review", turnId: "follow-up" }),
    ).resolves.toMatchObject({ state: "running" });
    expect(activity()).toEqual([{ task, agentId: run.id, serverId: run.destination.serverId }]);
    stop();
    stop = registerSequenceTracking(server, directory);
    expect(link({ action: "read", project })).toBe("paseo-project");
    expect(link({ action: "read", project: "other" })).toBeNull();
    expect(link({ action: "write", project, destination: null })).toBeNull();
    expect(link({ action: "read", project })).toBeNull();
    await expect(handle({ action: "read", task })).resolves.toMatchObject({
      id: run.id,
      taskIds: [task],
      turnId: "first",
    });
    await expect(handle({ action: "read", task: "other-task" })).resolves.toBeNull();
    await expect(
      handle({ action: "observe", task, id: run.id, state: "review", turnId: "first" }),
    ).resolves.toMatchObject({ state: "review" });
    expect(activity()).toEqual([]);
  } finally {
    stop();
  }
});
