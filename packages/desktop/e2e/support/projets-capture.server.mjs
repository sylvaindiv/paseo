import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { sequenceAction } from "./shared/sequence.js";
import { registerSequenceTracking } from "./server/sequence-tracking.js";

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
      {
        project: input.projetChoisi,
        phase: null,
        title: "Confirmer le résultat",
        existing: null,
        note: "",
        subtasks: ["Relire"],
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

function connect(dispatchFinished) {
  let controller;
  return {
    readable: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream({
      async write(message) {
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
          const prompt = message.params.prompt;
          if (prompt.some(({ type, text }) => type === "text" && text.startsWith("Projet · "))) {
            await dispatchFinished;
          }
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
  const projects = ["CVC Detailing", "Nature et Création"].map((title, index) => ({
    id: "project-" + index,
    title,
    kind: "project",
    notes: "",
    version: "initial",
    today: false,
    eligible: false,
    someday: false,
    checklist: [],
    images: [],
  }));
  const sequence = { day: 20261125, projects, rows: [] };
  const receipts = new Map();
  const attachments = new Map();
  server.handle(sequenceAction, (input) => {
    if (input.action === "read") return { sequence };
    if (input.action === "image") return { image: attachments.get(input.id) };
    if (input.action !== "capture") return {};
    const prior = receipts.get(input.id);
    if (prior || !input.tasks) return { receipt: prior };
    const ids = [];
    const labels = [];
    for (const draft of input.tasks) {
      const id = input.id + "-" + ids.length;
      const project = projects.find((row) => row.id === draft.project.id);
      if (!project) return { stale: true, error: "Vérifie le projet." };
      ids.push(id);
      labels.push(project.title + " · " + draft.title);
      sequence.rows.push({
        id,
        parent: project.id,
        title: draft.title,
        notes: draft.note,
        kind: "task",
        version: "created",
        today: draft.title === "Vérifier le bouton Ajouter",
        eligible: true,
        someday: false,
        checklist: draft.subtasks.map((title, index) => ({
          id: id + "-" + index,
          title,
          done: false,
        })),
        images: draft.images.map((index) => {
          const imageID = input.id + "-image-" + index;
          attachments.set(imageID, input.images[index]);
          return imageID;
        }),
      });
    }
    receipts.set(input.id, { ids, summary: labels.join("\n") });
    throw new Error("Réponse perdue.");
  });
  const dispatch = Promise.withResolvers();
  server.handle(
    defineRpc({
      name: "fixture.finish-dispatch",
      input: z.object({}),
      output: z.boolean(),
    }),
    () => {
      dispatch.resolve();
      return true;
    },
  );
  server.registerProvider(
    runAcpProvider({
      id: "capture-test",
      label: "Capture test",
      connector: () => connect(dispatch.promise),
    }),
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
  const stopTracking = registerSequenceTracking(server);
  return () => {
    dispatch.resolve();
    stopTracking();
  };
}
