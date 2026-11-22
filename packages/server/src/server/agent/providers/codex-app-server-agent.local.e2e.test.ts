import { describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";

import { agentBrowserEnv } from "../../agent-browser-env.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

function isCodexInstalled(): boolean {
  try {
    const out = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function hasAgentBrowser(): boolean {
  try {
    execFileSync("agent-browser", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sse(events: unknown[]): string {
  return events
    .map((event) => {
      const type =
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof (event as { type?: unknown }).type === "string"
          ? (event as { type: string }).type
          : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function responseCreated(id: string): Record<string, unknown> {
  return {
    type: "response.created",
    response: { id },
  };
}

function responseCompleted(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function functionCallEvent(
  callId: string,
  name: string,
  argumentsJson: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: argumentsJson,
    },
  };
}

function assistantMessageEvent(id: string, text: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

function requestUserInputSse(callId: string): string {
  return sse([
    responseCreated("resp-1"),
    functionCallEvent(
      callId,
      "request_user_input",
      JSON.stringify({
        questions: [
          {
            id: "confirm_path",
            header: "Confirm",
            question: "Proceed with the plan?",
            options: [
              {
                label: "Yes (Recommended)",
                description: "Continue the current plan.",
              },
              {
                label: "No",
                description: "Stop and revisit the approach.",
              },
            ],
          },
        ],
      }),
    ),
    responseCompleted("resp-1"),
  ]);
}

function assistantMessageSse(text: string): string {
  return sse([
    responseCreated("resp-2"),
    assistantMessageEvent("msg-1", text),
    responseCompleted("resp-2"),
  ]);
}

async function startMockResponsesServer(sequence: string[]): Promise<{
  url: string;
  close: () => Promise<void>;
  requestBodies: string[];
}> {
  const requestBodies: string[] = [];
  let index = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const body = sequence[index] ?? assistantMessageSse("done");
      index += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.end(body);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for mock responses server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function writeMockCodexConfig(codexHome: string, serverUrl: string): void {
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `
model = "mock-model"
approval_policy = "on-request"
sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "${serverUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
  );
}

function waitForEvent<TEvent extends AgentStreamEvent>(params: {
  session: {
    subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  };
  predicate: (event: AgentStreamEvent) => event is TEvent;
  timeoutMs: number;
  label: string;
}): Promise<TEvent> {
  return new Promise<TEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${params.label}`));
    }, params.timeoutMs);

    const unsubscribe = params.session.subscribe((event) => {
      if (!params.predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

describe("Codex app-server provider (local e2e)", () => {
  test.runIf(process.platform === "darwin" && isCodexInstalled() && hasAgentBrowser())(
    "closes only the owned agent-browser session when a Codex turn ends",
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "codex-browser-cleanup-"));
      const mockServer = await startMockResponsesServer([assistantMessageSse("finished")]);
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(home, "agents"), logger);
      const manager = new AgentManager({
        paseoHome: home,
        clients: { codex: new CodexAppServerAgentClient(logger) },
        registry: storage,
        logger,
      });
      const runBrowser = (env: Record<string, string>, ...args: string[]) =>
        execFileSync("agent-browser", args, {
          env: { ...process.env, ...env },
          encoding: "utf8",
          timeout: 10000,
        });
      const sessions = (env: Record<string, string>): string[] =>
        JSON.parse(runBrowser(env, "session", "list", "--json")).data.sessions;
      const other = agentBrowserEnv(home, { kind: "agent", id: "separate-test-owner" }, home);
      let owned: Record<string, string> | undefined;
      try {
        writeMockCodexConfig(home, mockServer.url);
        vi.stubEnv("CODEX_HOME", home);
        const { id } = await manager.createAgent(
          { provider: "codex", cwd: home, modeId: "auto", model: "mock-model" },
          undefined,
          { workspaceId: undefined },
        );
        owned = agentBrowserEnv(home, { kind: "agent", id }, home);
        runBrowser(owned, "open", "about:blank");
        runBrowser(other, "open", "about:blank");
        expect(sessions(owned)).toContain(owned.AGENT_BROWSER_SESSION);
        expect(sessions(other)).toContain(other.AGENT_BROWSER_SESSION);
        await manager.runAgent(id, "finish the browser task");
        await expect
          .poll(() => sessions(owned!), { timeout: 7000 })
          .toEqual([other.AGENT_BROWSER_SESSION]);
        expect(runBrowser(other, "get", "url").trim()).toBe("about:blank");
      } finally {
        for (const env of [owned, other]) {
          if (env && sessions(env).includes(env.AGENT_BROWSER_SESSION!)) runBrowser(env, "close");
        }
        for (const { id } of manager.listAgents()) await manager.closeAgent(id);
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.runIf(isCodexInstalled())(
    "keeps real Codex running while a background terminal is active",
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "codex-background-"));
      const mockServer = await startMockResponsesServer([
        sse([
          responseCreated("resp-background"),
          functionCallEvent(
            "call-background",
            "exec_command",
            JSON.stringify({ cmd: "sleep 12", yield_time_ms: 1000 }),
          ),
          responseCompleted("resp-background"),
        ]),
        assistantMessageSse("background started"),
      ]);
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(home, "agents"), logger);
      const manager = new AgentManager({
        paseoHome: home,
        clients: { codex: new CodexAppServerAgentClient(logger) },
        registry: storage,
        logger,
      });
      try {
        writeMockCodexConfig(home, mockServer.url);
        vi.stubEnv("CODEX_HOME", home);
        const { id } = await manager.createAgent(
          { provider: "codex", cwd: home, modeId: "auto", model: "mock-model" },
          undefined,
          { workspaceId: undefined },
        );
        const result = await manager.runAgent(id, "start a short background task");
        expect(result.finalText).toContain("background started");
        const agent = manager.getAgent(id);
        expect(agent?.lifecycle).toBe("idle");
        // Verify a terminal really exists, independently of the manager's verdict.
        const { client } = agent!.session as unknown as {
          client: {
            request(method: string, params: { threadId: string }): Promise<{ data: unknown[] }>;
          };
        };
        const terminals = await client.request("thread/backgroundTerminals/list", {
          threadId: agent!.persistence!.sessionId,
        });
        expect(terminals.data).toHaveLength(1);
        expect(await manager.hibernateAgent(id)).toBe(false);
        expect(manager.getAgent(id)?.session?.getRuntimePid?.()).toBeGreaterThan(1);
      } finally {
        for (const { id } of manager.listAgents()) await manager.closeAgent(id);
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.runIf(isCodexInstalled())(
    "hibernates a real idle Codex process and resumes the same history",
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "codex-hibernation-"));
      const mockServer = await startMockResponsesServer([assistantMessageSse("retained reply")]);
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(home, "agents"), logger);
      const manager = new AgentManager({
        paseoHome: home,
        clients: { codex: new CodexAppServerAgentClient(logger) },
        registry: storage,
        logger,
      });
      try {
        writeMockCodexConfig(home, mockServer.url);
        vi.stubEnv("CODEX_HOME", home);
        const { id } = await manager.createAgent(
          { provider: "codex", cwd: home, modeId: "auto", model: "mock-model" },
          undefined,
          { workspaceId: undefined },
        );
        await manager.runAgent(id, "keep this prompt");
        const threadId = manager.getAgent(id)?.persistence?.sessionId;
        expect(threadId).toBeTruthy();
        const history = manager.fetchTimeline(id, { limit: 0 });
        for (let cycle = 0; cycle < 3; cycle++) {
          const pid = manager.getAgent(id)?.session?.getRuntimePid?.();
          expect(pid).toBeGreaterThan(1);
          await expect.poll(() => manager.hibernateAgent(id), { timeout: 5000 }).toBe(true);
          expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
          const resumed = await ensureAgentLoaded(id, {
            agentManager: manager,
            agentStorage: storage,
            logger,
          });
          expect(resumed.persistence?.sessionId).toBe(threadId);
          expect(manager.fetchTimeline(id, { limit: 0 })).toEqual(history);
        }
      } finally {
        for (const { id } of manager.listAgents()) await manager.closeAgent(id);
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.runIf(isCodexInstalled()).each([
    { chrome: undefined, rea: undefined, expected: [] },
    { chrome: "1", rea: undefined, expected: ["chrome-devtools"] },
    { chrome: undefined, rea: "1", expected: ["rea"] },
  ])(
    "launches only opted-in Codex MCPs (Chrome=$chrome, REA=$rea) on create and resume",
    async ({ chrome, rea, expected }) => {
      const home = mkdtempSync(path.join(os.tmpdir(), "codex-mcp-defaults-"));
      const mockServer = await startMockResponsesServer([]);
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(home, "agents"), logger);
      const client = new CodexAppServerAgentClient(logger, {
        env: {
          CODEX_HOME: home,
          ...(chrome ? { PASEO_CODEX_CHROME_DEVTOOLS: chrome } : {}),
          ...(rea ? { PASEO_CODEX_REA_MCP: rea } : {}),
        },
      });
      const manager = new AgentManager({
        paseoHome: home,
        clients: { codex: client },
        registry: storage,
        logger,
      });
      const launches = path.join(home, "launches");
      try {
        writeMockCodexConfig(home, mockServer.url);
        vi.stubEnv("PASEO_CODEX_CHROME_DEVTOOLS", undefined);
        vi.stubEnv("PASEO_CODEX_REA_MCP", undefined);
        const fakeServer = path.join(home, "mcp.mjs");
        writeFileSync(
          fakeServer,
          String.raw`
import { appendFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
const [name, launches] = process.argv.slice(2);
appendFileSync(launches, name + "\n");
const server = new McpServer({ name, version: "1.0.0" });
server.registerTool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
`,
        );
        const mcpConfig = ["chrome-devtools", "rea"]
          .map(
            (name) => `
[mcp_servers.${name}]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([fakeServer, name, launches])}
required = true
`,
          )
          .join("");
        writeFileSync(path.join(home, "config.toml"), mcpConfig, { flag: "a" });

        const config = {
          provider: "codex",
          cwd: home,
          modeId: "auto",
          model: "mock-model",
        } as const;
        const { id } = await manager.createAgent(config, undefined, {
          workspaceId: undefined,
        });
        const checkTools = () => {
          const tools = JSON.parse(mockServer.requestBodies.at(-1)!).tools;
          const names: Array<string | undefined> = tools.map(
            (tool: { name?: string }) => tool.name,
          );
          for (const name of ["chrome-devtools", "rea"]) {
            expect(
              names.some((tool) => tool?.startsWith(`mcp__${name.replaceAll("-", "_")}`)),
              names.join(", "),
            ).toBe(expected.includes(name));
          }
        };
        expect((await manager.runAgent(id, "verify startup")).finalText).toBe("done");
        checkTools();
        const launched = () =>
          existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n") : [];
        expect(launched()).toEqual(expected);

        await manager.reloadAgentSession(id, undefined, { rehydrateFromDisk: true });
        expect((await manager.runAgent(id, "verify resume")).finalText).toBe("done");
        checkTools();
        expect(launched()).toEqual([...expected, ...expected]);

        // The workspace history reader resumes without browser ownership.
        const persistence = manager.getAgent(id)?.persistence;
        await manager.closeAgent(id);
        const history = await client.resumeSession(persistence!, config, undefined, {
          purpose: "history",
        });
        try {
          for await (const _event of history.streamHistory()) {
            // Drain the persisted history.
          }
          expect(launched()).toEqual([...expected, ...expected]);
        } finally {
          await history.close();
        }
      } finally {
        for (const { id } of manager.listAgents()) await manager.closeAgent(id);
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.runIf(isCodexInstalled())(
    "reloads a persisted idle thread repeatedly without overlapping writers",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-reload-cwd-"));
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-reload-home-"));
      const mockServer = await startMockResponsesServer([assistantMessageSse("saved")]);
      const logger = createTestLogger();
      const storage = new AgentStorage(path.join(cwd, "agents"), logger);
      const manager = new AgentManager({
        clients: { codex: new CodexAppServerAgentClient(logger) },
        registry: storage,
        logger,
      });
      let agentId: string | undefined;
      try {
        writeMockCodexConfig(codexHome, mockServer.url);
        vi.stubEnv("CODEX_HOME", codexHome);
        const created = await manager.createAgent(
          { provider: "codex", cwd, modeId: "auto", model: "mock-model" },
          undefined,
          { workspaceId: undefined },
        );
        agentId = created.id;
        await manager.runAgent(agentId, "save this turn");
        const threadId = manager.getAgent(agentId)?.persistence?.sessionId;
        expect(threadId).toBeTruthy();
        for (let i = 0; i < 3; i++) {
          const reloaded = await manager.reloadAgentSession(agentId, undefined, {
            rehydrateFromDisk: true,
          });
          expect(reloaded.persistence?.sessionId).toBe(threadId);
          expect(reloaded.lifecycle).toBe("idle");
        }
        await manager.runAgent(agentId, "continue after reload");
        expect(manager.getAgent(agentId)?.lifecycle).toBe("idle");
      } finally {
        if (agentId && manager.getAgent(agentId)) await manager.closeAgent(agentId);
        await storage.flush();
        vi.unstubAllEnvs();
        await mockServer.close();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.runIf(isCodexInstalled())(
    "surfaces request_user_input from the app-server as question permissions and timeline tool calls",
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-app-server-question-cwd-"));
      const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-app-server-question-home-"));
      const mockServer = await startMockResponsesServer([
        requestUserInputSse("call1"),
        assistantMessageSse("done"),
      ]);

      try {
        writeMockCodexConfig(codexHome, mockServer.url);

        const client = new CodexAppServerAgentClient(createTestLogger());
        const session = await client.createSession(
          {
            provider: "codex",
            cwd,
            modeId: "auto",
            model: "mock-model",
            thinkingOptionId: "medium",
          },
          {
            env: {
              CODEX_HOME: codexHome,
            },
          },
        );

        try {
          await session.setFeature?.("plan_mode", true);

          const events: AgentStreamEvent[] = [];
          session.subscribe((event) => {
            events.push(event);
          });

          const questionRequested = waitForEvent({
            session,
            timeoutMs: 15_000,
            label: "question permission request",
            predicate: (
              event,
            ): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
              event.type === "permission_requested" &&
              event.request.provider === "codex" &&
              event.request.kind === "question" &&
              event.request.name === "request_user_input",
          });

          const turnFinished = waitForEvent({
            session,
            timeoutMs: 15_000,
            label: "turn completion",
            predicate: (
              event,
            ): event is Extract<
              AgentStreamEvent,
              { type: "turn_completed" | "turn_failed" | "turn_canceled" }
            > =>
              event.type === "turn_completed" ||
              event.type === "turn_failed" ||
              event.type === "turn_canceled",
          });

          await session.startTurn("ask something");

          const permissionEvent = await questionRequested;
          await expect(session.canCloseForInactivity?.()).resolves.toBe(false);
          expect(permissionEvent.request.input).toEqual({
            questions: [
              {
                id: "confirm_path",
                header: "Confirm",
                question: "Proceed with the plan?",
                isOther: true,
                options: [
                  {
                    label: "Yes (Recommended)",
                    description: "Continue the current plan.",
                  },
                  {
                    label: "No",
                    description: "Stop and revisit the approach.",
                  },
                ],
              },
            ],
          });

          const runningQuestionCall = events.find(
            (event) =>
              event.type === "timeline" &&
              event.provider === "codex" &&
              event.item.type === "tool_call" &&
              event.item.name === "request_user_input" &&
              event.item.status === "running",
          );
          expect(runningQuestionCall).toBeDefined();

          await session.respondToPermission(permissionEvent.request.id, {
            behavior: "allow",
            updatedInput: {
              answers: {
                Confirm: "Yes (Recommended)",
              },
            },
          });

          const terminalEvent = await turnFinished;
          expect(terminalEvent.type).toBe("turn_completed");

          const completedQuestionCall = events.find(
            (event) =>
              event.type === "timeline" &&
              event.provider === "codex" &&
              event.item.type === "tool_call" &&
              event.item.name === "request_user_input" &&
              event.item.status === "completed",
          );
          expect(completedQuestionCall).toBeDefined();
          if (
            !completedQuestionCall ||
            completedQuestionCall.type !== "timeline" ||
            completedQuestionCall.item.type !== "tool_call"
          ) {
            throw new Error("Expected completed request_user_input tool call");
          }
          expect(completedQuestionCall.item.metadata).toMatchObject({
            answers: {
              confirm_path: ["Yes (Recommended)"],
            },
          });
          expect(
            mockServer.requestBodies.some(
              (body) =>
                body.includes('"type":"function_call_output"') &&
                body.includes('"call_id":"call1"'),
            ),
          ).toBe(true);

          const finalAssistantMessage = [...events]
            .toReversed()
            .find((event) => event.type === "timeline" && event.item.type === "assistant_message");
          expect(finalAssistantMessage).toBeDefined();
          if (
            !finalAssistantMessage ||
            finalAssistantMessage.type !== "timeline" ||
            finalAssistantMessage.item.type !== "assistant_message"
          ) {
            throw new Error("Expected final assistant message");
          }
          expect(finalAssistantMessage.item.text.trim()).toBe("done");
        } finally {
          await session.close();
        }
      } finally {
        await mockServer.close();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(codexHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
