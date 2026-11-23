import path from "node:path";
import { cp, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "../../app/e2e/support/fixtures";
import { installDesktopRuntime } from "./support/runtime";
import { getE2EDaemonPort, daemonWsRoutePattern } from "../../app/e2e/support/helpers/daemon-port";

async function voiceHarness(page: Page, transcript: string) {
  let audioReceived!: () => void;
  const audio = new Promise<void>((resolve) => {
    audioReceived = resolve;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const envelope = JSON.parse(String(raw)) as {
        type?: string;
        message?: { type?: string; dictationId?: string; seq?: number };
      };
      const request = envelope.message;
      if (envelope.type === "session" && request?.dictationId) {
        const dictationId = request.dictationId;
        const send = (message: unknown) => ws.send(JSON.stringify({ type: "session", message }));
        if (request.type === "dictation_stream_start") {
          send({ type: "dictation_stream_ack", payload: { dictationId, ackSeq: -1 } });
          return;
        }
        if (request.type === "dictation_stream_chunk") {
          send({ type: "dictation_stream_ack", payload: { dictationId, ackSeq: request.seq } });
          audioReceived();
          return;
        }
        if (request.type === "dictation_stream_finish") {
          send({
            type: "dictation_stream_finish_accepted",
            payload: { dictationId, timeoutMs: 5000 },
          });
          send({
            type: "dictation_stream_final",
            payload: { dictationId, text: transcript },
          });
          return;
        }
        if (request.type === "dictation_stream_cancel") return;
      }
      server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  return { audio };
}

const message = "Ajouter une tâche de vérification du bouton Ajouter. Le projet reste à préciser.";
const projectName = "Nature et Création";

async function setupCapture(page: Page) {
  const voice = await voiceHarness(page, message);
  const serverId = process.env.E2E_SERVER_ID!;
  await page.setViewportSize({ width: 720, height: 620 });
  await page.setContent(
    '<main style="padding:60px;font:24px system-ui;background:#f3f4f6;height:480px"><h1>Boutique</h1><p>Le bouton Ajouter reste inactif.</p><button style="border:3px solid red;padding:12px 28px;font:inherit">Ajouter</button></main>',
  );
  const png = (await page.screenshot()).toString("base64");
  const id = randomUUID();
  await installDesktopRuntime(page, {
    serverId,
    daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
  });
  await page.addInitScript(
    (capture) => {
      const gestures = new Set<
        (event: { id: string; phase: "began" | "ended" | "cancelled" }) => void
      >();
      const updates = new Set<(value: typeof capture | null) => void>();
      const saved = sessionStorage.getItem("capture-fixture") === "released";
      let draft: typeof capture | null = saved ? capture : null;
      Reflect.set(window, "captureHold", (phase: "began" | "ended" | "cancelled") => {
        for (const callback of gestures) callback({ id: capture.id, phase });
        if (phase === "ended") {
          draft = capture;
          sessionStorage.setItem("capture-fixture", "released");
          for (const callback of updates) callback(draft);
        }
      });
      window.paseoDesktop!.desktopCapture = {
        getDraft: async () => draft,
        device: async () => capture.deviceId,
        onGesture(callback) {
          gestures.add(callback);
          return () => gestures.delete(callback);
        },
        async present() {
          for (const callback of updates) callback(draft);
        },
        onUpdate(callback) {
          updates.add(callback);
          return () => updates.delete(callback);
        },
        async cancel() {
          draft = null;
          sessionStorage.removeItem("capture-fixture");
          for (const callback of updates) callback(null);
        },
        execute: async () => {
          throw new Error("No desktop action expected");
        },
        revoke: async () => {},
        onStop: () => () => {},
      };
    },
    {
      id,
      serverId,
      png,
      deviceId: randomUUID(),
      width: 720,
      height: 620,
      context: { application: "Finder", windowTitle: "Boutique", selectedText: "Bouton inactif" },
      ocr: "Ajouter",
      captureMs: 12,
      gesture: true,
    },
  );
  await page.goto("/desktop-capture");
  await expect(page.getByText("Prêt à capturer", { exact: true })).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => Reflect.get(window, "captureHold")("began"));
  await voice.audio;
  return { id, serverId };
}

async function readBoard(page: Page, serverId: string) {
  return page.evaluate(async (host) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("projets-dossiers", 1);
      open.onsuccess = () => resolve(open.result);
      open.addEventListener("error", () => reject(open.error));
    });
    try {
      return await new Promise<{
        items: Array<{
          id: number;
          project: number;
          title: string;
          note?: string;
          images?: Array<{ name: string; size: number }>;
        }>;
        recordedCaptures?: Record<string, string>;
      } | null>((resolve, reject) => {
        if (!database.objectStoreNames.contains("boards")) {
          reject(new Error("Projets board store not initialized"));
          return;
        }
        const read = database.transaction("boards").objectStore("boards").get(host);
        read.onsuccess = () => {
          const board = read.result;
          resolve(
            board
              ? {
                  recordedCaptures: board.recordedCaptures,
                  items: board.items.map(
                    ({
                      id,
                      project,
                      title,
                      note,
                      images,
                    }: {
                      id: number;
                      project: number;
                      title: string;
                      note?: string;
                      images?: Array<{ file: File }>;
                    }) => ({
                      id,
                      project,
                      title,
                      note,
                      images: images?.map(({ file }) => ({ name: file.name, size: file.size })),
                    }),
                  ),
                }
              : null,
          );
        };
        read.addEventListener("error", () => reject(read.error));
      });
    } finally {
      database.close();
    }
  }, serverId);
}

test.use({ e2eDaemonConfig: { version: 1, pluginsEnabled: true } });

test("release opens a draft and saves one task after clarification and confirmation", async ({
  page,
  e2eWorkerClient,
}, testInfo) => {
  const repo = path.resolve(__dirname, "../../..");
  const fixtures = path.join(repo, ".dev");
  await mkdir(fixtures, { recursive: true });
  const source = await mkdtemp(path.join(fixtures, "projets-capture-e2e-"));
  try {
    await cp(path.join(repo, "plugins/projets"), source, { recursive: true });
    await copyFile(
      path.join(__dirname, "support/projets-capture.server.mjs"),
      path.join(source, "index.server.ts"),
    );
    await e2eWorkerClient.installPluginSource({ source });
    const { id, serverId } = await setupCapture(page);
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    const send = page.getByRole("button", { name: "Envoyer", exact: true });
    await expect(editor).toBeHidden();
    await page.evaluate(() => Reflect.get(window, "captureHold")("ended"));
    await expect(editor).toHaveValue(message);
    await expect(send).toBeEnabled();
    await expect(page.getByRole("img", { name: "Capture.png" })).toBeVisible();
    expect(await readBoard(page, serverId)).toBeNull();
    expect((await e2eWorkerClient.fetchAgents({ scope: "active" })).entries).toHaveLength(0);

    await e2eWorkerClient.disablePlugin("projets");
    await expect(page.getByText("Projets indisponible. Brouillon conservé.")).toBeVisible();
    await e2eWorkerClient.enablePlugin("projets");
    await expect(editor).toHaveValue(message);
    await expect(page.getByRole("img", { name: "Capture.png" })).toBeVisible();
    await send.click();
    await expect(page.getByText("Quel projet ?", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(editor).toHaveValue(message);
    expect(await readBoard(page, serverId)).toBeNull();

    await editor.fill(
      "Ajouter une tâche de vérification du bouton Ajouter. J’ai vu ce souci sur CVC Detailing.",
    );
    await page
      .getByRole("combobox", { name: "Projet", exact: true })
      .selectOption({ label: projectName });
    await expect(page.getByRole("img", { name: "Capture.png" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("capture-brouillon.png") });
    await send.dblclick();
    await expect(page.getByText(/Enregistré.*Nature et Création/s)).toBeVisible({
      timeout: 15_000,
    });
    const board = await readBoard(page, serverId);
    const added = board?.items.filter((task) =>
      task.images?.some(({ name }) => name === "Capture.png"),
    );
    expect(added).toHaveLength(1);
    expect(added?.[0]).toMatchObject({
      project: 1,
      note: "Bouton inactif",
      images: [{ name: "Capture.png", size: expect.any(Number) }],
    });
    expect(added![0].images![0].size).toBeGreaterThan(0);
    expect(board?.recordedCaptures?.[id]).toContain(projectName);
    await page.screenshot({ path: testInfo.outputPath("capture-enregistree.png") });

    await page.reload();
    await expect(page.getByText(/Enregistré.*Nature et Création/s)).toBeVisible();
    expect(await readBoard(page, serverId)).toEqual(board);
    const agents = await e2eWorkerClient.fetchAgents({ scope: "active" });
    expect(agents.entries.every(({ agent }) => agent.title === "Ajout de tâches")).toBe(true);
  } finally {
    await page.close();
    await e2eWorkerClient.removePlugin("projets");
    await rm(source, { recursive: true, force: true });
    const workspace = (await e2eWorkerClient.fetchWorkspaces()).entries.find(
      (entry) =>
        entry.workspaceDirectory === path.join(process.env.E2E_PASEO_HOME!, "Ajout de tâches"),
    );
    if (workspace) await e2eWorkerClient.removeProject(workspace.projectId);
  }
});

test("Escape cancels the hold and the manual plus starts empty", async ({
  page,
  e2eWorkerClient,
}) => {
  await e2eWorkerClient.installPluginSource({
    source: path.resolve(__dirname, "../../../plugins/projets"),
  });
  try {
    const { serverId } = await setupCapture(page);
    await page.evaluate(() => Reflect.get(window, "captureHold")("cancelled"));
    await expect(page.getByText("Prêt à capturer", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeHidden();
    await page.goto(`/h/${serverId}/plugin/projets/surface/main`);
    const add = page.getByRole("button", { name: "Ajouter des tâches", exact: true }).first();
    await expect(add).toBeAttached();
    await add.focus();
    await add.click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Envoyer", exact: true })).toBeDisabled();
    await expect(page.getByRole("img", { name: "Capture.png" })).toBeHidden();
  } finally {
    await page.close();
    await e2eWorkerClient.removePlugin("projets");
  }
});
