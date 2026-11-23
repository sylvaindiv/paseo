import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const session = defineRpc({
  name: "capture.session",
  input: z.object({ id: z.uuid(), action: z.enum(["open", "keep", "close"]) }),
  output: z.object({ ok: z.boolean() }),
});

function reply(prompt) {
  const text = prompt.find(({ type }) => type === "text")?.text;
  if (!text?.startsWith('{"projetChoisi":')) return { title: "Ajout de tâches" };
  const input = JSON.parse(text);
  if (input.projetChoisi === null) return { message: "Quel projet ?", tasks: [] };
  return {
    message: "",
    tasks: [
      {
        project: input.projetChoisi,
        phase: null,
        title: "Vérifier le bouton Ajouter",
        existing: null,
        note: input.observationsEcran.selectedText,
        subtasks: [],
        images: [],
      },
    ],
  };
}

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fixture",
    options: [{ value: "fixture", name: "Fixture" }],
  },
];

function connect() {
  let controller;
  return {
    readable: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream({
      write(message) {
        if (!("method" in message) || !("id" in message)) return;
        let result = {};
        if (message.method === "initialize") {
          result = {
            protocolVersion: 1,
            agentCapabilities: { promptCapabilities: { image: true } },
          };
        }
        if (message.method === "session/new") result = { sessionId: "capture-test", configOptions };
        if (message.method === "session/set_config_option") result = { configOptions };
        if (message.method === "session/prompt") {
          controller.enqueue({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "capture-test",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: JSON.stringify(reply(message.params.prompt)) },
              },
            },
          });
          result = { stopReason: "end_turn" };
        }
        controller.enqueue({ jsonrpc: "2.0", id: message.id, result });
      },
    }),
  };
}

// A deterministic provider for the renderer test. Projets' real Codex profile is exercised in Dev.
export default function contribute(server) {
  server.registerProvider(
    runAcpProvider({ id: "capture-test", label: "Capture test", connector: connect }),
  );
  server.handle(session, async ({ action, id }, { paseo }) => {
    if (action === "open") {
      const cwd = path.join(process.env.PASEO_HOME, "Ajout de tâches");
      await mkdir(cwd, { recursive: true });
      const workspace = await paseo.workspaces.open(cwd);
      await workspace.agents.create({
        agentId: id,
        idempotencyKey: id,
        title: "Ajout de tâches",
        config: { provider: "capture-test/fixture" },
      });
    }
    if (action === "close") await paseo.agents.ref(id).archive();
    return { ok: true };
  });
  return () => {};
}
