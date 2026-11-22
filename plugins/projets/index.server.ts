import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerTaskCapture } from "./server/task-capture.js";
import { homedir } from "node:os";
import path from "node:path";
import { openProjectTodoStore } from "./server/project-todos.js";
import {
  batchLabel,
  readProjectTodos,
  readProjectsOverview,
  writeProjectTodo,
} from "./shared/project-todos.js";

export default function contribute(server: PluginServerContext) {
  const stopCapture = registerTaskCapture(server);
  let store: ReturnType<typeof openProjectTodoStore> | undefined;
  function getStore() {
    const home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
    store ??= openProjectTodoStore(path.join(home, "projects-todos.sqlite3"));
    return store;
  }

  server.handle(readProjectTodos, ({ projectKey }) => getStore().read(projectKey));
  server.handle(readProjectsOverview, ({ projectKeys }) => getStore().readOverview(projectKeys));
  server.handle(writeProjectTodo, ({ projectKey, change }) => {
    const list = getStore().write(projectKey, change);
    if (change.operation === "batch-reserve" || change.operation === "batch-observe") {
      return {
        ok: true as const,
        batch: list.dispatch?.batches.find((batch) => batch.id === change.batchId),
      };
    }
    return { ok: true as const };
  });
  const offStart = server.on("agent.turn_started", ({ agent, turnId }) => {
    if (agent.labels[batchLabel] === agent.id)
      getStore().observeAgent(agent.id, "running", turnId ?? undefined);
  });
  const offEnd = server.on("agent.turn_ended", ({ agent, turnId, outcome }) => {
    if (agent.labels[batchLabel] === agent.id) {
      getStore().observeAgent(
        agent.id,
        outcome.kind === "completed" ? "review" : "failed",
        turnId ?? undefined,
      );
    }
  });
  return async () => {
    await stopCapture();
    offStart();
    offEnd();
    store?.close();
  };
}
