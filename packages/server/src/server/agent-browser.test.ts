import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { agentBrowserEnv, AgentBrowserDashboards } from "./agent-browser.js";
import { execCommand } from "../utils/spawn.js";

// Replace only the installed CLI boundary; readiness still exercises a real HTTP server.
vi.mock("../utils/spawn.js", () => ({ execCommand: vi.fn() }));
vi.mock("../executable-resolution/executable-resolution.js", () => ({ findExecutable: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(findExecutable).mockResolvedValue("agent-browser");
  vi.mocked(readFile).mockRejectedValue(new Error("No dashboard sidecar"));
});
const servers: Server[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("agent-browser workspace association", () => {
  it("is stable, separates installations and workspaces, and gives each owner a default session", () => {
    const owner = { kind: "agent" as const, id: "one" };
    const first = agentBrowserEnv("workspace-a", owner, "/installation-a");
    expect(first.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("300000");
    expect(agentBrowserEnv("workspace-a", owner, "/installation-a")).toEqual(first);
    expect(
      agentBrowserEnv("workspace-b", owner, "/installation-a").AGENT_BROWSER_NAMESPACE,
    ).not.toBe(first.AGENT_BROWSER_NAMESPACE);
    expect(
      agentBrowserEnv("workspace-a", owner, "/installation-b").AGENT_BROWSER_NAMESPACE,
    ).not.toBe(first.AGENT_BROWSER_NAMESPACE);
    const sibling = agentBrowserEnv("workspace-a", { kind: "agent", id: "two" }, "/installation-a");
    expect(sibling.AGENT_BROWSER_NAMESPACE).toBe(first.AGENT_BROWSER_NAMESPACE);
    expect(sibling.AGENT_BROWSER_SESSION).not.toBe(first.AGENT_BROWSER_SESSION);
    expect(
      agentBrowserEnv("workspace-a", { kind: "terminal", id: "one" }, "/installation-a")
        .AGENT_BROWSER_SESSION,
    ).not.toBe(first.AGENT_BROWSER_SESSION);
  });
});

function emptyDashboard() {
  return createServer((request, response) => {
    response.writeHead(request.headers.origin === `http://${request.headers.host}` ? 200 : 403, {
      "Content-Type": "application/json",
    });
    response.end("[]");
  });
}

describe("agent-browser dashboard", () => {
  it("stops only its own dashboard after an in-flight launch finishes", async () => {
    const sidecars = new Map<string, string>();
    vi.mocked(readFile).mockImplementation(async (path) => {
      const value = sidecars.get(String(path));
      if (!value) throw new Error("No dashboard sidecar");
      return value;
    });
    let finishLaunch!: () => void;
    let notifyLaunch!: () => void;
    const launched = new Promise<void>((resolve) => {
      notifyLaunch = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    const stopped: string[] = [];
    vi.mocked(execCommand).mockImplementation(async (_command, args, options) => {
      if (args[0] === "--version") return { stdout: "agent-browser 0.37.1", stderr: "" };
      const env = options!.envOverlay!;
      const directory = `${env.AGENT_BROWSER_SOCKET_DIR}/namespaces/${env.AGENT_BROWSER_NAMESPACE}/run`;
      if (args[1] === "stop") {
        stopped.push(env.AGENT_BROWSER_NAMESPACE!);
        sidecars.delete(`${directory}/dashboard.pid`);
        return { stdout: "", stderr: "" };
      }
      const server = emptyDashboard();
      servers.push(server);
      const port = Number(args[3]);
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      sidecars.set(`${directory}/dashboard.pid`, String(process.pid));
      sidecars.set(`${directory}/dashboard.config`, JSON.stringify({ port }));
      notifyLaunch();
      await blocked;
      return { stdout: "", stderr: "" };
    });
    const service = new AgentBrowserDashboards("/test-dashboard-home");
    const opening = service.open("owned");
    await launched;
    const disposing = service.dispose();
    expect(stopped).toEqual([]);
    finishLaunch();
    await opening;
    await disposing;
    await service.dispose();
    expect(stopped).toEqual([
      agentBrowserEnv("owned", { kind: "agent", id: "dashboard" }, "/test-dashboard-home")
        .AGENT_BROWSER_NAMESPACE,
    ]);
    await expect(service.open("new")).rejects.toMatchObject({ code: "start_failed" });
  });

  it("leaves an adopted dashboard running on shutdown", async () => {
    const server = emptyDashboard();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    vi.mocked(readFile).mockImplementation(async (path) =>
      String(path).endsWith(".pid") ? String(process.pid) : JSON.stringify({ port: address.port }),
    );
    vi.mocked(execCommand).mockResolvedValue({ stdout: "agent-browser 0.37.1", stderr: "" });
    const service = new AgentBrowserDashboards("/test-dashboard-home");
    await service.open("adopted");
    await service.dispose();
    expect(vi.mocked(execCommand).mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["dashboard", "start", "--port", String(address.port), "--json"],
    ]);
  });

  it("groups concurrent launches, reuses a ready dashboard, and isolates workspace ports", async () => {
    const launches: { namespace: string; args: string[] }[] = [];
    vi.mocked(execCommand).mockImplementation(async (_command, args, options) => {
      if (args[0] === "--version") return { stdout: "agent-browser 0.37.1", stderr: "" };
      launches.push({ namespace: options!.envOverlay!.AGENT_BROWSER_NAMESPACE!, args });
      const server = emptyDashboard();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(Number(args[3]), "127.0.0.1", resolve));
      return { stdout: "", stderr: "" };
    });
    const service = new AgentBrowserDashboards("/test-dashboard-home");
    const [one, same, other] = await Promise.all([
      service.open("first"),
      service.open("first"),
      service.open("second"),
    ]);
    expect(one).toBe(same);
    expect(other).not.toBe(one);
    expect(await service.open("first")).toBe(one);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.namespace).not.toBe(launches[1]!.namespace);
    expect(launches[0]!.args).toEqual([
      "dashboard",
      "start",
      "--port",
      expect.any(String),
      "--json",
    ]);
  });

  it("reports an absent tool and permits retry", async () => {
    vi.mocked(findExecutable).mockResolvedValueOnce(null);
    const service = new AgentBrowserDashboards("/test-dashboard-home");
    await expect(service.open("one")).rejects.toMatchObject({ code: "tool_missing" });
    vi.mocked(execCommand).mockResolvedValue({ stdout: "agent-browser 0.36.0", stderr: "" });
    await expect(service.open("one")).rejects.toMatchObject({ code: "version_incompatible" });
  });

  it("reports a failed dashboard startup", async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce({ stdout: "agent-browser 0.37.1", stderr: "" })
      .mockRejectedValueOnce(new Error("port unavailable"));
    await expect(
      new AgentBrowserDashboards("/test-dashboard-home").open("one"),
    ).rejects.toMatchObject({ code: "start_failed" });
  });
});
