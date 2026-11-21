import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execCommand } from "../utils/spawn.js";
import { agentBrowserEnv } from "./agent-browser-env.js";
export { agentBrowserEnv } from "./agent-browser-env.js";

export async function closeAgentBrowser(
  env: Record<string, string>,
  mayClose: () => boolean,
  verify?: () => Promise<boolean>,
): Promise<void> {
  const session = env.AGENT_BROWSER_SESSION;
  const socketDir = env.AGENT_BROWSER_SOCKET_DIR;
  const namespace = env.AGENT_BROWSER_NAMESPACE;
  if (!session || !socketDir || !namespace || !mayClose()) return;
  // Agent-browser has nothing to close before this session's socket exists.
  if (process.platform !== "win32") {
    const socket = join(socketDir, "namespaces", namespace, "run", `${session}.sock`);
    if (!(await lstat(socket).catch(() => null))?.isSocket()) return;
  }
  const executable = await findExecutable("agent-browser");
  if (!executable) return;
  const run = (args: string[]) =>
    execCommand(executable, args, { envOverlay: env, timeout: 2500, maxBuffer: 64 * 1024 });
  const { stdout } = await run(["session", "list", "--json"]);
  const sessions = JSON.parse(stdout)?.data?.sessions;
  if (!Array.isArray(sessions) || !sessions.includes(session) || !mayClose()) return;
  if (verify && !(await verify())) return;
  if (mayClose()) await run(["close"]);
}

export type AgentBrowserErrorCode = "tool_missing" | "version_incompatible" | "start_failed";
export class AgentBrowserError extends Error {
  readonly code: AgentBrowserErrorCode;
  constructor(code: AgentBrowserErrorCode) {
    super(code);
    this.code = code;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new AgentBrowserError("start_failed");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );
  return address.port;
}

async function ready(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/sessions`, {
      signal: AbortSignal.timeout(500),
      headers: { Origin: url },
    });
    return response.ok && Array.isArray(await response.json());
  } catch {
    return false;
  }
}

export class AgentBrowserDashboards {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly owned = new Map<
    string,
    { pid: number; port: number; stop: () => Promise<unknown> }
  >();
  private readonly stopping = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly paseoHome: string;
  constructor(paseoHome: string) {
    this.paseoHome = paseoHome;
  }

  async open(workspaceId: string): Promise<string> {
    await this.stopping.get(workspaceId);
    if (this.disposed) throw new AgentBrowserError("start_failed");
    const existing = this.pending.get(workspaceId);
    if (existing) {
      const url = await existing;
      if (await ready(url)) return url;
      if (this.pending.get(workspaceId) === existing) this.pending.delete(workspaceId);
      return this.open(workspaceId);
    }
    const opening = this.start(workspaceId);
    this.pending.set(workspaceId, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.pending.get(workspaceId) === opening) this.pending.delete(workspaceId);
      throw error;
    }
  }

  stop(workspaceId: string): Promise<void> {
    const existing = this.stopping.get(workspaceId);
    if (existing) return existing;
    const stopping = (async () => {
      await this.pending.get(workspaceId)?.catch(() => undefined);
      this.pending.delete(workspaceId);
      await this.stopOwned(workspaceId);
    })().finally(() => this.stopping.delete(workspaceId));
    this.stopping.set(workspaceId, stopping);
    return stopping;
  }

  private async stopOwned(workspaceId: string): Promise<void> {
    const owned = this.owned.get(workspaceId);
    if (!owned) return;
    const current = await readDashboard(this.directory(workspaceId));
    // A replacement or a dashboard adopted from another process is not ours to stop.
    if (current?.pid === owned.pid && current.port === owned.port) await owned.stop();
    this.owned.delete(workspaceId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled(
      [...new Set([...this.pending.keys(), ...this.owned.keys()])].map((id) => this.stop(id)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private directory(workspaceId: string): string {
    const env = agentBrowserEnv(workspaceId, { kind: "agent", id: "dashboard" }, this.paseoHome);
    return join(env.AGENT_BROWSER_SOCKET_DIR!, "namespaces", env.AGENT_BROWSER_NAMESPACE!, "run");
  }

  private async start(workspaceId: string): Promise<string> {
    const env = agentBrowserEnv(workspaceId, { kind: "agent", id: "dashboard" }, this.paseoHome);
    const executable = await findExecutable("agent-browser");
    if (!executable) throw new AgentBrowserError("tool_missing");
    const run = (args: string[]) =>
      execCommand(executable, args, {
        envOverlay: { ...env, AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS: undefined },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    let version: string;
    try {
      version = (await run(["--version"])).stdout;
    } catch (error) {
      throw new AgentBrowserError(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "tool_missing" : "start_failed",
      );
    }
    // 0.37.1 is the first version verified with namespaced dashboard discovery and local-origin checks.
    const match = /agent-browser (\d+)\.(\d+)\.(\d+)/.exec(version);
    if (
      !match ||
      (Number(match[1]) === 0 &&
        (Number(match[2]) < 37 || (Number(match[2]) === 37 && Number(match[3]) < 1)))
    ) {
      throw new AgentBrowserError("version_incompatible");
    }
    const directory = this.directory(workspaceId);
    const previous = await readDashboard(directory);
    const port = previous?.port ?? (await availablePort());
    try {
      await run(["dashboard", "start", "--port", String(port), "--json"]);
      const started = await readDashboard(directory);
      if (!previous && started?.port === port) {
        this.owned.set(workspaceId, {
          ...started,
          stop: () => run(["dashboard", "stop", "--json"]),
        });
      }
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (await ready(url)) return url;
        await delay(150);
      }
      throw new AgentBrowserError("start_failed");
    } catch {
      await this.stopOwned(workspaceId).catch(() => undefined);
      throw new AgentBrowserError("start_failed");
    }
  }
}

async function readDashboard(directory: string): Promise<{ pid: number; port: number } | null> {
  try {
    const pid = Number(await readFile(join(directory, "dashboard.pid"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    const config = JSON.parse(await readFile(join(directory, "dashboard.config"), "utf8"));
    if (Number.isInteger(config.port) && config.port > 0 && config.port <= 65535)
      return { pid, port: config.port };
  } catch {
    // Stale sidecars are cleaned up by agent-browser itself.
  }
  return null;
}

const services = new Map<string, AgentBrowserDashboards>();
export function agentBrowserDashboardsForHome(home: string): AgentBrowserDashboards {
  const key = resolvePath(home);
  let service = services.get(key);
  if (!service) {
    service = new AgentBrowserDashboards(key);
    services.set(key, service);
  }
  return service;
}

export async function disposeAgentBrowserDashboardsForHome(home: string): Promise<void> {
  const key = resolvePath(home);
  const service = services.get(key);
  if (!service) return;
  await service.dispose();
  if (services.get(key) === service) services.delete(key);
}
