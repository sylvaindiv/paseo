// Run after npm run build:main --workspace=@getpaseo/desktop.
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../../../.context/agent-widget");
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(os.tmpdir(), "paseo-widget-"));
const app = await electron.launch({
  args: [path.join(here, "fixtures/agent-widget.cjs")],
  env: { ...process.env, PASEO_WIDGET_TEST_HOME: home },
});
const labels = {
  plan: "Plan prêt",
  question: "Réponse attendue",
  execute: "Exécuter",
  comment: "Ajouter une consigne…",
  sendComment: "Envoyer",
  handoff: "Handoff",
  submit: "Envoyer la réponse",
  next: "Suivant",
  close: "Fermer",
  minimize: "Réduire",
  pending: "Envoi…",
  sent: "Réponse envoyée",
  offline: "Hôte déconnecté",
  failed: "Erreur",
};
const plan = {
  key: JSON.stringify(["host", "agent", "plan"]),
  serverId: "host",
  agentId: "agent",
  requestId: "plan",
  workspaceId: "workspace",
  planCallId: "plan-call",
  planText: "# Exact plan",
  agentTitle: "Codex",
  workspace: "Paseo · accra",
  title: "Un agent à portée de main",
  kind: "plan",
  canApprove: true,
  questions: [],
  planHtml:
    "<h1>Un agent à portée de main</h1><p>Retrouver votre agent sans quitter votre travail.</p><h2>1. Une fenêtre au bon endroit</h2><p>Afficher le widget en bas à droite de l’écran principal, au-dessus des applications ouvertes.</p><h2>2. Le contexte avant la décision</h2><p>Présenter le projet, l’agent et le plan. Garder les actions accessibles pendant la lecture.</p><h2>3. Une réponse sans changer de fenêtre</h2><p>Exécuter le plan ou envoyer une consigne à l’agent.</p><h2>Vérifications prévues</h2><p>Tester les plans longs, les questions et les changements de demande.</p>",
};
const question = {
  ...plan,
  key: JSON.stringify(["host", "agent2", "question"]),
  agentId: "agent2",
  requestId: "question",
  agentTitle: "Claude",
  kind: "question",
  planHtml: "",
  questions: [
    {
      header: "Moment",
      question: "Quand le widget doit-il apparaître ?",
      options: [
        { label: "À chaque demande", description: "Plans prêts et questions." },
        { label: "Si Paseo est masqué", description: "Quand vous travaillez ailleurs." },
      ],
      multiSelect: false,
      allowOther: true,
      allowEmpty: false,
    },
    {
      header: "Contenu",
      question: "Que souhaitez-vous voir ?",
      options: [{ label: "Le projet" }, { label: "Les étapes" }],
      multiSelect: true,
      allowOther: false,
      allowEmpty: false,
    },
    {
      header: "Contrainte",
      question: "Une contrainte supplémentaire ?",
      options: [],
      multiSelect: false,
      allowOther: false,
      allowEmpty: true,
    },
  ],
};
try {
  const owner = await app.firstWindow();
  await owner.waitForFunction(() => Boolean(window.paseoDesktop?.agentWidget));
  await owner.evaluate(() => {
    window.widgetActions = [];
    window.widgetError = "La réponse n’a pas pu être envoyée. Réessayez.";
    window.paseoDesktop.agentWidget.onAction((delivery) => {
      window.widgetActions.push(delivery.action);
      void window.paseoDesktop.agentWidget.result({
        operationId: delivery.operationId,
        error: window.widgetError,
      });
    });
  });
  const opened = app.waitForEvent("window");
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  const widget = await opened;
  const errors = [];
  widget.on("pageerror", (error) => errors.push(error.message));
  await expect(widget.locator("#comment")).toBeVisible();
  const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Paseo");
    return {
      bounds: win.getBounds(),
      area: screen.getPrimaryDisplay().workArea,
      focused: win.isFocused(),
      top: win.isAlwaysOnTop(),
    };
  });
  expect(geometry.top).toBe(true);
  expect(geometry.focused).toBe(false);
  expect(geometry.bounds.x + geometry.bounds.width).toBe(
    geometry.area.x + geometry.area.width - 16,
  );
  expect(geometry.bounds.y + geometry.bounds.height).toBe(
    geometry.area.y + geometry.area.height - 16,
  );
  await widget.locator("#comment").fill("Garde le widget silencieux.");
  await widget.screenshot({ path: path.join(output, "plan.png") });
  await widget.locator("#comment").press("Enter");
  await expect(widget.locator(".notice.error")).toContainText("Réessayez");
  await expect(widget.locator("#comment")).toHaveValue("Garde le widget silencieux.");
  await widget.screenshot({ path: path.join(output, "error.png") });
  await widget.locator("[data-action=next]").click();
  await expect(widget.locator(".question-title")).toContainText("Quand");
  await widget.screenshot({ path: path.join(output, "question.png") });
  await widget.locator("input[name=option]").first().check();
  await widget.locator("[data-action=question-next]").click();
  await widget.locator("input[name=option]").nth(0).check();
  await widget.locator("input[name=option]").nth(1).check();
  await widget.screenshot({ path: path.join(output, "multiple.png") });
  await widget.locator("[data-action=question-next]").click();
  await expect(widget.locator("[data-action=answer]")).toBeEnabled();
  await widget.locator("#answer").fill("Ne pas interrompre la saisie.");
  await widget.screenshot({ path: path.join(output, "free.png") });
  await owner.evaluate(() => (window.widgetError = null));
  await widget.locator("[data-action=answer]").click();
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.screenshot({ path: path.join(output, "reduced-after-answer.png") });
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator("#comment")).toHaveValue("Garde le widget silencieux.");
  await widget.locator("#handoff").click();
  await expect(widget.locator(".pill")).toBeVisible();
  const actions = await owner.evaluate(() => window.widgetActions);
  expect(actions.map((action) => action.type)).toEqual(["comment", "answer", "handoff"]);
  expect(actions[2]).toMatchObject({ planCallId: "plan-call", planText: "# Exact plan" });
  expect(actions[1].selections).toEqual([[0], [0, 1], []]);
  expect(actions[1].texts).toEqual(["", "", "Ne pas interrompre la saisie."]);
  // A lagging owner snapshot cannot resurrect a handled request.
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [plan, question],
    labels,
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Paseo")
          ?.isVisible(),
      ),
    )
    .toBe(false);
  const newPlan = { ...plan, key: JSON.stringify(["host", "agent", "plan2"]), requestId: "plan2" };
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: false,
    requests: [newPlan],
    labels,
  });
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator("[data-action=approve]")).toBeDisabled();
  await expect(widget.locator(".notice")).toHaveText("Hôte déconnecté");
  await widget.screenshot({ path: path.join(output, "offline.png") });
  await owner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [newPlan],
    labels,
  });
  await widget.locator("[data-action=reduce]").first().click();
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.screenshot({ path: path.join(output, "reduced.png") });
  await widget.locator("[data-action=restore]").click();
  await widget.locator("[data-action=approve]").click();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Paseo")
          ?.isVisible(),
      ),
    )
    .toBe(false);
  // Another application window shares the queue, then takes over when its peer closes.
  const secondOpened = app.waitForEvent("window");
  await app.evaluate(() => globalThis.createWidgetOwner());
  const secondOwner = await secondOpened;
  await secondOwner.waitForFunction(() => Boolean(window.paseoDesktop?.agentWidget));
  await secondOwner.evaluate(() => {
    window.widgetActions = [];
    window.widgetMode = "normal";
    window.paseoDesktop.agentWidget.onAction((delivery) => {
      window.widgetActions.push(delivery.action);
      if (window.widgetMode === "silent") return;
      if (window.widgetMode === "long") {
        const keepAlive = setInterval(() => {
          void window.paseoDesktop.agentWidget.progress(delivery.operationId);
        }, 10_000);
        setTimeout(() => {
          clearInterval(keepAlive);
          void window.paseoDesktop.agentWidget.result({
            operationId: delivery.operationId,
            error: null,
          });
        }, 33_000);
        return;
      }
      void window.paseoDesktop.agentWidget.result({
        operationId: delivery.operationId,
        error: null,
      });
    });
  });
  const sharedPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "shared"]),
    requestId: "shared",
  };
  const sharedSnapshot = { serverId: "host", online: true, requests: [sharedPlan], labels };
  await owner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await secondOwner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await expect(widget.locator(".queue span")).toHaveText("1 / 1");
  await widget.locator("#comment").fill("Conserver cette consigne lors des mises à jour.");
  await owner.evaluate(
    (snapshot) => window.paseoDesktop.agentWidget.publish(snapshot),
    sharedSnapshot,
  );
  await expect(widget.locator("#comment")).toBeFocused();
  await expect(widget.locator("#comment")).toHaveValue(
    "Conserver cette consigne lors des mises à jour.",
  );
  await owner.close();
  await expect(widget.locator(".queue span")).toHaveText("1 / 1");
  await widget.locator("[data-action=approve]").click();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Paseo")
          ?.isVisible(),
      ),
    )
    .toBe(false);
  expect(
    await secondOwner.evaluate(() => window.widgetActions.map((action) => action.type)),
  ).toEqual(["approve"]);
  const longPlan = { ...plan, key: JSON.stringify(["host", "agent", "long"]), requestId: "long" };
  await secondOwner.evaluate(() => (window.widgetMode = "long"));
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [longPlan],
    labels,
  });
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await widget.locator("#handoff").click();
  await expect(widget.locator("#handoff")).toBeDisabled();
  await expect.poll(() => secondOwner.evaluate(() => window.widgetActions.length)).toBe(2);
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.getTitle() === "Paseo")
            ?.isVisible(),
        ),
      { timeout: 40_000 },
    )
    .toBe(false);
  expect(await secondOwner.evaluate(() => window.widgetActions.length)).toBe(2);

  const silentPlan = {
    ...plan,
    key: JSON.stringify(["host", "agent", "silent"]),
    requestId: "silent",
  };
  await secondOwner.evaluate(() => (window.widgetMode = "silent"));
  await secondOwner.evaluate((snapshot) => window.paseoDesktop.agentWidget.publish(snapshot), {
    serverId: "host",
    online: true,
    requests: [silentPlan],
    labels,
  });
  await expect(widget.locator(".pill")).toBeVisible();
  await widget.locator("[data-action=restore]").click();
  await widget.locator("#comment").fill("Brouillon à préserver");
  await widget.locator("#handoff").click();
  await expect(widget.locator(".notice.error")).toContainText("No confirmation", {
    timeout: 35_000,
  });
  await expect(widget.locator("#comment")).toHaveValue("Brouillon à préserver");
  await widget.screenshot({ path: path.join(output, "handoff-timeout.png") });
  await secondOwner.evaluate(() => (window.widgetMode = "normal"));
  await widget.locator("#handoff").click();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Paseo")
          ?.isVisible(),
      ),
    )
    .toBe(false);
  const sizeChecks = await app.evaluate(() => {
    const widgetBounds = globalThis.widgetBounds;
    return [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
    ].map((size) => ({ size, bounds: widgetBounds({ x: 0, y: 0, ...size }, false) }));
  });
  for (const { size, bounds } of sizeChecks) {
    expect(bounds.x + bounds.width).toBe(size.width - 16);
    expect(bounds.y + bounds.height).toBe(size.height - 16);
  }
  expect(errors).toEqual([]);
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify({ passed: true, geometry, actions, pageErrors: errors }, null, 2),
  );
  console.log(
    "PASS: native window, no focus theft, primary screen bounds, feedback failure/retry, questions, drafts, stale snapshots, offline, collapse, approval, multi-window deduplication and takeover, draft focus and screen sizes.",
  );
} finally {
  await app.close();
  await rm(home, { recursive: true, force: true });
}
