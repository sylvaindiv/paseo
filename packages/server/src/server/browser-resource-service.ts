import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Logger } from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { agentBrowserEnv } from "./agent-browser-env.js";
import { browserProcessSchema, type BrowserOwner } from "./browser-resource-state.js";
import { writeBrowserResourceJson } from "./browser-resource-worker.js";
const run = promisify(execFile);
const eventSchema = z.object({
  id: z.string(),
  installation: z.string(),
  owner: z.string(),
  bytes: z.number(),
  reason: z.enum(["memory", "owner_closed", "owner_idle"]),
  result: z.enum(["stopped", "failed"]),
  timestamp: z.number(),
});

export async function startBrowserResourceService(input: {
  paseoHome: string;
  agentManager: AgentManager;
  terminalManager: TerminalManager;
  persistedRecords: StoredAgentRecord[];
  logger: Logger;
}): Promise<() => Promise<void>> {
  if (process.platform !== "darwin") return async () => {};
  const directory = join(homedir(), ".paseo-browser-resource");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Electron cannot execute a native binary inside asar.
  const binary = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../../dist/server/server/paseo-browser-resource"
        : "./paseo-browser-resource",
      import.meta.url,
    ),
  ).replace(/\.asar\//, ".asar.unpacked/");
  await access(binary, constants.X_OK);
  const processes = z
    .array(browserProcessSchema)
    .parse(JSON.parse((await run(binary, ["snapshot"], { maxBuffer: 16 * 1024 ** 2 })).stdout));
  const daemon = processes.find((p) => p.pid === process.pid);
  if (!daemon) throw new Error("Browser resource guard cannot identify its daemon");
  const installation = agentBrowserEnv(
    "",
    { kind: "agent", id: "" },
    input.paseoHome,
  ).PASEO_BROWSER_INSTALLATION!;
  const leasePath = join(directory, `${installation}.json`);
  const owners = new Map<string, BrowserOwner>();
  function update(
    workspace: string,
    kind: "agent" | "terminal",
    id: string,
    closed: boolean,
    lastActiveAt: number,
  ): void {
    const env = agentBrowserEnv(workspace, { kind, id }, input.paseoHome);
    const owner = `${kind}:${id}`;
    owners.set(owner, {
      installation,
      owner,
      namespace: env.AGENT_BROWSER_NAMESPACE!,
      session: env.AGENT_BROWSER_SESSION!,
      closed,
      lastActiveAt,
    });
  }
  for (const record of input.persistedRecords)
    update(
      record.workspaceId ?? record.cwd,
      "agent",
      record.id,
      true,
      Date.parse(record.updatedAt),
    );
  const refreshAgents = () => {
    const live = new Set(input.agentManager.listAgents().map((agent) => `agent:${agent.id}`));
    for (const owner of owners.values())
      if (owner.owner.startsWith("agent:") && !live.has(owner.owner)) owner.closed = true;
    for (const agent of input.agentManager.listAgents())
      update(
        agent.workspaceId ?? agent.cwd,
        "agent",
        agent.id,
        agent.lifecycle === "closed",
        agent.lifecycle === "running" ? Date.now() : agent.updatedAt.getTime(),
      );
  };
  refreshAgents();
  const refreshTerminals = async () => {
    const current = new Set<string>();
    for (const cwd of input.terminalManager.listDirectories()) {
      for (const terminal of await input.terminalManager.getTerminals(cwd)) {
        const owner = `terminal:${terminal.id}`;
        current.add(owner);
        const activity = terminal.getActivity();
        update(
          terminal.workspaceId,
          "terminal",
          terminal.id,
          false,
          activity?.state === "working"
            ? Date.now()
            : (activity?.changedAt ?? owners.get(owner)?.lastActiveAt ?? Date.now()),
        );
      }
    }
    for (const owner of owners.values())
      if (owner.owner.startsWith("terminal:") && !current.has(owner.owner)) owner.closed = true;
  };
  let lastAck = "";
  try {
    lastAck = await readFile(join(directory, `${installation}.ack`), "utf8");
  } catch {
    /* No previously delivered events. */
  }
  let stopped = false;
  let pending = Promise.resolve();
  const save = () => {
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (stopped) return;
        refreshAgents();
        await refreshTerminals();
        await writeBrowserResourceJson(leasePath, {
          daemon: { pid: daemon.pid, startedAt: daemon.startedAt },
          owners: [...owners.values()]
            .sort((a, b) => Number(a.closed) - Number(b.closed) || b.lastActiveAt - a.lastActiveAt)
            .slice(0, 10000),
        });
        let events: z.infer<typeof eventSchema>[];
        try {
          events = z
            .array(eventSchema)
            .parse(JSON.parse(await readFile(join(directory, `${installation}.events`), "utf8")));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
          throw error;
        }
        const index = events.findIndex((e) => e.id === lastAck);
        for (const event of events.slice(index + 1)) {
          input.logger.info(
            { owner: event.owner, bytes: event.bytes, reason: event.reason },
            "Browser resource guard intervention",
          );
          let text = "Navigateur arrêté : session inactive.";
          if (event.reason === "memory") text = "Navigateur arrêté : mémoire excessive.";
          if (event.result === "failed") text = "Impossible d’arrêter le navigateur.";
          if (event.owner.startsWith("agent:")) {
            const id = event.owner.slice(6);
            if (input.agentManager.getAgent(id))
              await input.agentManager.appendTimelineItem(id, { type: "assistant_message", text });
          } else if (event.owner.startsWith("terminal:")) {
            await input.terminalManager.setTerminalActivity(event.owner.slice(9), "attention");
          }
          lastAck = event.id;
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(directory, `${installation}.ack`), lastAck, { mode: 0o600 });
        }
        return;
      });
    void pending.catch((err) =>
      input.logger.warn({ err }, "Browser resource guard lease update failed"),
    );
    return pending;
  };
  await save();
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./browser-resource-worker.ts"
        : "./browser-resource-worker.js",
      import.meta.url,
    ),
  );
  const args = import.meta.url.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx"), worker, directory, binary]
    : [
        fileURLToPath(new URL("./browser-resource-entry.cjs", import.meta.url)).replace(
          /\.asar\//,
          ".asar.unpacked/",
        ),
        worker,
        directory,
        binary,
      ];
  let lastSpawnAt = 0;
  async function ensureWorker(): Promise<void> {
    let updatedAt = 0;
    try {
      updatedAt = (await stat(join(directory, "status.json"))).mtimeMs;
    } catch {
      /* No worker heartbeat yet. */
    }
    if (Date.now() - Math.max(updatedAt, lastSpawnAt) < 10000) return;
    lastSpawnAt = Date.now();
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PASEO_DAEMON_GENERATION: undefined,
        PASEO_DAEMON_SHARED_PROCESS: "1",
      },
    });
    child.on("error", (err) =>
      input.logger.error({ err }, "Browser resource guard failed to start"),
    );
    child.on("exit", (code) => {
      if (code) input.logger.error({ code }, "Browser resource guard exited");
    });
    child.unref();
  }
  await ensureWorker();
  const onAgent = input.agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state") void save();
    },
    { replayState: false },
  );
  const onTerminal = input.terminalManager.subscribeTerminalsChanged(() => {
    void save();
  });
  const onActivity = input.terminalManager.subscribeTerminalActivity(() => {
    void save();
  });
  const timer = setInterval(() => {
    void save();
    void ensureWorker().catch((err) =>
      input.logger.error({ err }, "Browser resource guard recovery failed"),
    );
  }, 2000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    onAgent();
    onTerminal();
    onActivity();
    await pending.catch(() => {});
    stopped = true;
    await writeBrowserResourceJson(leasePath, {
      daemon: { pid: daemon.pid, startedAt: daemon.startedAt },
      owners: [...owners.values()].map((o) => Object.assign(o, { closed: true })),
    });
  };
}
