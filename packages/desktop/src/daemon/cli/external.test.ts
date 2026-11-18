import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./external";

const mocks = vi.hoisted(() => ({
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: ["runner.js", "node-script", "cli.js"],
    env: { PASEO_NODE_ENV: "production" },
  })),
  resolveExternalCliEntrypoint: vi.fn(() => ({
    entryPath: "cli.js",
    execArgv: [],
  })),
  spawnProcess: vi.fn(),
}));

vi.mock("@getpaseo/server/process", () => ({
  spawnProcess: mocks.spawnProcess,
}));

vi.mock("electron-log/main", () => ({
  default: { warn: vi.fn() },
}));

vi.mock("../runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
}));

vi.mock("./entrypoints.js", () => ({
  resolveExternalCliEntrypoint: mocks.resolveExternalCliEntrypoint,
}));

function mockExternalCliOutput(input: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}): void {
  mocks.spawnProcess.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    process.nextTick(() => {
      if (input.stdout.length > 0) {
        child.stdout.emit("data", Buffer.from(input.stdout));
      }
      if (input.stderr && input.stderr.length > 0) {
        child.stderr.emit("data", Buffer.from(input.stderr));
      }
      child.emit("close", input.exitCode ?? 0);
    });

    return child;
  });
}

describe("external CLI", () => {
  it("bounds a CLI that never exits and terminates that child", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      mocks.spawnProcess.mockReturnValueOnce(child);
      const result = runExternalCliJsonCommand(["daemon", "status", "--json"]);
      const rejected = expect(result).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(90_000);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("runs text commands through an isolated CLI process", async () => {
    mockExternalCliOutput({ stdout: "daemon running\n" });

    await expect(runExternalCliTextCommand(["daemon", "status"])).resolves.toBe("daemon running");

    expect(mocks.createNodeEntrypointInvocation).toHaveBeenCalledWith({
      entrypoint: { entryPath: "cli.js", execArgv: [] },
      argvMode: "node-script",
      args: ["daemon", "status"],
      baseEnv: process.env,
    });
    expect(mocks.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["runner.js", "node-script", "cli.js"],
      {
        envMode: "internal",
        env: { PASEO_NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("preserves a structured daemon refusal from CLI stderr", async () => {
    mockExternalCliOutput({
      stdout: "",
      stderr: JSON.stringify({
        error: { code: "DAEMON_BUSY", message: "Un agent travaille encore." },
      }),
      exitCode: 1,
    });
    await expect(runExternalCliJsonCommand(["daemon", "stop", "--json"])).rejects.toMatchObject({
      code: "DAEMON_BUSY",
      message: "Un agent travaille encore.",
    });
  });

  it("parses JSON output from an isolated CLI process", async () => {
    mockExternalCliOutput({ stdout: '{"localDaemon":"running"}\n' });

    await expect(runExternalCliJsonCommand(["daemon", "status", "--json"])).resolves.toEqual({
      localDaemon: "running",
    });
  });
});
