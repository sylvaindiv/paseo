import path from "node:path";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

test.use({ video: "off", trace: "off" });

test("Projets keeps project lists separate from workspace To-do", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "project-todos-", git: false });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const { config } = await client.getDaemonConfig();
  try {
    await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, 0, {
      operation: "add",
      title: "Workspace-only task",
      notes: "",
    });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(path.resolve(__dirname, "../../../../plugins/projets"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Projets", exact: true }).click();

    const board = page.getByTestId("projets-page");
    const list = board.getByTestId("projets-local-list");
    await expect(list).toBeVisible();
    await expect(board.getByTestId("projets-project-rank")).toHaveCount(0);
    await expect(board.getByTestId("projets-project-settings")).toHaveCount(0);
    await expect(list.getByText("Tâches", { exact: true })).toBeVisible();
    await expect(board).toHaveCSS("background-color", "rgb(242, 237, 227)");
    await expect(board.getByText("Workspace-only task")).toBeHidden();
    await list.getByRole("button", { name: /Ajouter une tâche/ }).click();
    const input = list.getByRole("textbox", { name: "Nouvelle tâche", exact: true });
    await input.fill("Project-only task");
    await input.press("Enter");
    const title = list.getByRole("button", { name: "Modifier Project-only task", exact: true });
    await expect(title).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill("Next project task");
    await input.press("Enter");
    await expect(list.getByText("Next project task", { exact: true })).toBeVisible();
    await expect(input).toBeFocused();
    await input.press("Escape");

    await title.click();
    const editor = list.getByRole("textbox", { name: "Modifier Project-only task", exact: true });
    await expect(editor).toBeFocused();
    const notes = list.getByRole("textbox", { name: "Notes", exact: true });
    await expect(notes).toBeVisible();
    await editor.press("ArrowDown");
    await expect(notes).toBeFocused();
    await notes.fill("Vérifier le parcours avant la livraison.");
    await notes.press("ArrowDown");
    const subtask = list.getByRole("textbox", { name: "Nouvelle sous-tâche", exact: true });
    await expect(subtask).toBeFocused();
    await subtask.fill("Project subtask");
    await subtask.press("Enter");
    await expect(list.getByText("Project subtask", { exact: true })).toBeVisible();
    await expect(subtask).toBeFocused();
    await subtask.press("Escape");

    const projectHeader = board.getByTestId("projets-card-header");
    const projectTitle = projectHeader.getByRole("button", { name: /^project-todos-/ });
    const addPhase = projectHeader.getByRole("button", { name: /^Ajouter une phase à / });
    const phaseInput = list.getByPlaceholder("Nouvelle phase");
    await expect(list.getByRole("button", { name: "+ Phase", exact: true })).toHaveCount(0);
    await expect(addPhase).toHaveAttribute("data-no-dnd", "");
    await projectTitle.click();
    await expect(projectTitle).toHaveAttribute("aria-expanded", "false");
    await addPhase.click();
    await expect(projectTitle).toHaveAttribute("aria-expanded", "true");
    await expect(phaseInput).toBeFocused();
    await phaseInput.fill("Review");
    await phaseInput.press("Enter");
    const phaseActions = list.getByRole("button", {
      name: "Actions de la phase Review",
      exact: true,
    });
    await phaseActions.click();
    const phaseMenu = page.getByRole("menu", { name: "Actions de la phase Review", exact: true });
    await expect(phaseMenu).toBeVisible();
    await expect(phaseMenu).toHaveCSS("background-color", "rgb(247, 245, 237)");
    await phaseMenu.getByRole("menuitem", { name: "Supprimer la phase", exact: true }).click();
    await expect(
      phaseMenu.getByRole("menuitem", { name: "Confirmer la suppression" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(phaseMenu).toBeHidden();
    await phaseActions.click();
    await phaseMenu.getByRole("menuitem", { name: "Renommer" }).click();
    const renamePhase = list.getByRole("textbox", {
      name: "Renommer la phase Review",
      exact: true,
    });
    await expect(renamePhase).toHaveValue("Review");
    await renamePhase.press("Enter");
    await expect(renamePhase).toBeHidden();

    const review = list.getByRole("button", { name: "Phase Review", exact: true });
    await expect(review).toHaveAttribute("aria-expanded", "true");
    await review.click();
    await expect(review).toHaveAttribute("aria-expanded", "false");
    const target = list.locator("[data-projets-drop-phase]").filter({
      has: page.getByRole("button", { name: "Phase Review", exact: true }),
    });
    const from = (await title.boundingBox())!;
    await page.mouse.move(from.x + 12, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 32, from.y + from.height / 2, { steps: 4 });
    const to = (await review.boundingBox())!;
    await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 16 });
    await expect(target).toHaveCSS("outline-width", "2px");
    await page.mouse.up();

    await expect(target.getByText("Project-only task", { exact: true })).toBeVisible();
    await expect(target.getByText("Project subtask", { exact: true })).toBeVisible();
    await page.reload();
    await review.click();
    await expect(target.getByText("Project-only task", { exact: true })).toBeVisible();
    await expect(target.getByText("Project subtask", { exact: true })).toBeVisible();
    const menuTrigger = target.getByRole("button", {
      name: "Actions de Project-only task",
      exact: true,
    });
    await title.hover();
    await expect(menuTrigger).toHaveCSS("opacity", "1");
    await menuTrigger.click();
    const menu = page.getByRole("menu", { name: "Actions", exact: true });
    await expect(menu.getByRole("menuitem", { name: "Modifier", exact: true })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Modifier", exact: true }).click();
    await expect(editor).toBeFocused();
    await expect(notes).toHaveValue("Vérifier le parcours avant la livraison.");
    await editor.press("Escape");

    const queue = list.getByTestId("projets-queue");
    await expect(queue).toContainText("À envoyer");
    await dragOnBoard(page, title, queue, "y");
    await expect(queue.getByText("Project-only task", { exact: true })).toBeVisible();
    await expect(target.getByText("Project-only task", { exact: true })).toBeVisible();
    await page.reload();
    await expect(queue.getByText("Project-only task", { exact: true })).toBeVisible();
    await queue.getByRole("button", { name: "Retirer Project-only task de l’envoi" }).click();
    await expect(queue.getByText("Project-only task", { exact: true })).toBeHidden();
    await review.click();

    const begin = target.getByRole("checkbox", {
      name: "Commencer Project-only task",
      exact: true,
    });
    await begin.click();
    const finish = target.getByRole("checkbox", {
      name: "Terminer Project-only task",
      exact: true,
    });
    await expect(finish).toHaveAttribute("aria-checked", "mixed");
    await finish.click();
    await target.getByRole("button", { name: "Terminées · 1", exact: true }).click();
    await expect(
      target.getByRole("checkbox", { name: "Rouvrir Project-only task", exact: true }),
    ).toBeChecked();

    const reviewHeader = list.getByRole("group", { name: "Déplacer la phase Review", exact: true });
    const firstPhaseHeader = list.getByRole("group", {
      name: "Déplacer la phase Phase 1",
      exact: true,
    });
    await expect(list.getByRole("button", { name: /^Déplacer la phase / })).toHaveCount(0);
    await dragOnBoard(
      page,
      reviewHeader.getByRole("button", { name: "Review", exact: true }),
      firstPhaseHeader,
      "y",
    );
    await expect(
      list.locator("[data-projets-drop-phase]").first().getByRole("button", {
        name: "Phase Review",
        exact: true,
      }),
    ).toBeVisible();
    const orderedPhases = list.locator("[data-projets-drop-phase]");
    const activePhaseId = await orderedPhases.first().getAttribute("data-projets-drop-phase");
    const nextPhaseId = await orderedPhases.last().getAttribute("data-projets-drop-phase");
    const phaseAnnouncement = (destinationId: string | null) =>
      "Draggable item phase:" +
      activePhaseId +
      " was moved over droppable area phase:" +
      destinationId +
      ".";
    await reviewHeader.focus();
    await page.keyboard.press("Space");
    await expect(reviewHeader).toHaveAttribute("data-dragging", "true");
    await expect(page.getByText(phaseAnnouncement(activePhaseId), { exact: true })).toBeAttached();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByText(phaseAnnouncement(nextPhaseId), { exact: true })).toBeAttached();
    await page.keyboard.press("Space");
    await expect(
      list.locator("[data-projets-drop-phase]").first().getByRole("button", {
        name: "Phase Phase 1",
        exact: true,
      }),
    ).toBeVisible();
    await dragOnBoard(page, reviewHeader, firstPhaseHeader, "y", 0.16);
    await expect(
      list.locator("[data-projets-drop-phase]").first().getByRole("button", {
        name: "Phase Review",
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      list.locator("[data-projets-drop-phase]").first().getByRole("button", {
        name: "Phase Review",
        exact: true,
      }),
    ).toBeVisible();

    const another = await seedWorkspace({ repoPrefix: "project-order-", git: false });
    try {
      const cards = board.getByTestId("projets-card");
      await expect(cards).toHaveCount(2);
      const firstBar = cards.first().getByRole("group", { name: /^Déplacer le projet / });
      const secondBar = cards.last().getByRole("group", { name: /^Déplacer le projet / });
      await expect(board.getByRole("button", { name: /^Déplacer le projet / })).toHaveCount(0);
      const firstProject = (await firstBar.getAttribute("aria-label"))!;
      const secondProject = (await secondBar.getAttribute("aria-label"))!;
      const firstName = firstProject.replace("Déplacer le projet ", "");
      const firstTitle = cards.first().getByRole("button", { name: firstName, exact: true });
      const firstHeader = cards.first().getByTestId("projets-card-header");
      await expect(cards.first().getByText(firstName, { exact: true })).toHaveCount(1);
      await firstTitle.click();
      await expect(firstTitle).toHaveAttribute("aria-expanded", "false");
      await firstTitle.click();
      await expect(firstTitle).toHaveAttribute("aria-expanded", "true");

      await dragOnBoard(
        page,
        firstTitle.getByText(firstName, { exact: true }),
        secondBar,
        "x",
        0.05,
      );
      await expect(firstBar).toHaveAttribute("aria-label", secondProject);
      await expect(board.getByRole("button", { name: firstName, exact: true })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await dragOnBoard(page, firstHeader, secondBar, "x", 0.015);
      await expect(firstBar).toHaveAttribute("aria-label", firstProject);
      await dragOnBoard(page, firstHeader, secondBar, "x", 0.75);
      await expect(firstBar).toHaveAttribute("aria-label", secondProject);
      await page.reload();
      await expect(firstBar).toHaveAttribute("aria-label", secondProject);
      const secondName = secondProject.replace("Déplacer le projet ", "");
      await cards
        .first()
        .getByRole("button", { name: "Actions de " + secondName })
        .click();
      await expect(page.getByRole("menuitem", { name: "Réglages du projet" })).toBeVisible();
      await page.getByRole("menuitem", { name: "Terminer le projet" }).click();
      await expect(cards).toHaveCount(1);
      await expect(cards.first().getByText(firstName, { exact: true })).toBeVisible();
      await board.getByRole("button", { name: "Terminés · 1" }).click();
      const finished = board.getByTestId("projets-finished");
      await expect(finished.getByText(secondName, { exact: true })).toBeVisible();
      await board.screenshot({ path: testInfo.outputPath("projets-termines.png") });
      await finished.getByRole("button", { name: "Actions de " + secondName }).click();
      await page.getByRole("menuitem", { name: "Rouvrir" }).click();
      await expect(firstBar).toHaveAttribute("aria-label", secondProject);
      await cards
        .first()
        .getByRole("button", { name: "Actions de " + secondName })
        .click();
      await page.getByRole("menuitem", { name: "Déplacer à droite" }).press("Enter");
      await expect(secondBar).toHaveAttribute("aria-label", secondProject);
      await secondBar.focus();
      await page.keyboard.press("Space");
      await expect(secondBar).toHaveAttribute("data-dragging", "true");
      const projectAnnouncement = page.getByText(
        /^Draggable item (?!phase:).+ was moved over droppable area (?!phase:).+\.$/,
      );
      await expect(projectAnnouncement).toBeAttached();
      const initialAnnouncement = await projectAnnouncement.textContent();
      await page.keyboard.press("ArrowLeft");
      await expect(projectAnnouncement).not.toHaveText(initialAnnouncement!);
      await page.keyboard.press("Space");
      await expect(firstBar).toHaveAttribute("aria-label", secondProject);
      await expect(
        board.getByRole("button", { name: /prioritaire|Déplacer à (droite|gauche)/ }),
      ).toHaveCount(0);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(board).toBeVisible();
      const row = board.getByTestId("projets-cards");
      await expect
        .poll(async () => {
          const [first, second] = await Promise.all([
            cards.first().boundingBox(),
            cards.last().boundingBox(),
          ]);
          const viewport = await row.boundingBox();
          return Boolean(
            first &&
            second &&
            viewport &&
            first.y === second.y &&
            second.x + second.width > viewport.x + viewport.width,
          );
        })
        .toBe(true);
      await expect(async () => {
        await cards.last().scrollIntoViewIfNeeded({ timeout: 2_000 });
        await expect(list.last()).toBeInViewport({ timeout: 2_000 });
      }).toPass({ timeout: 10_000 });
      await board.screenshot({ path: testInfo.outputPath("projets-palette-mobile.png") });
      await page.setViewportSize({ width: 1440, height: 900 });
    } finally {
      await another.cleanup();
    }

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByText("Workspace-only task", { exact: true })).toBeVisible();
    await expect(page.getByText("Project-only task", { exact: true })).toBeHidden();
  } finally {
    await client.removePlugin("projets").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.pluginsEnabled ?? false });
    await client.close();
    await workspace.cleanup();
  }
});

test("Projets opens a read-only overview on demand", async ({ page }) => {
  const active = await seedWorkspace({ repoPrefix: "overview-active-", git: false });
  const empty = await seedWorkspace({ repoPrefix: "overview-empty-", git: false });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "project-overview" });
  const { config } = await client.getDaemonConfig();
  const write = (change: object) =>
    client.invokePluginRpc("projets", "todos.write", { projectKey: active.projectKey, change });
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    let rejected = false;
    let rejectedRequestId: string | undefined;
    socket.onMessage((message) => {
      if (!rejected && typeof message === "string") {
        const parsed = JSON.parse(message);
        const session = parsed.message ?? parsed;
        if (
          session.type === "plugin.rpc.invoke.request" &&
          session.method === "todos.overview.get"
        ) {
          rejected = true;
          rejectedRequestId = session.requestId;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === "string" && rejectedRequestId) {
        const parsed = JSON.parse(message);
        const session = parsed.message ?? parsed;
        if (
          session.type === "plugin.rpc.invoke.response" &&
          session.payload.requestId === rejectedRequestId
        ) {
          rejectedRequestId = undefined;
          session.payload.output = null;
          socket.send(JSON.stringify(parsed));
          return;
        }
      }
      socket.send(message);
    });
  });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(path.resolve(__dirname, "../../../../plugins/projets"));
    await write({ operation: "phase-status", phaseId: "default", status: "EN ATTENTE" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Projets", exact: true }).click();

    const board = page.getByTestId("projets-page");
    const open = board.getByRole("button", { name: "Aperçu", exact: true });
    const card = board.getByRole("button", { name: active.projectDisplayName, exact: true });
    const panel = page.getByTestId("projets-overview");
    const rows = panel.getByTestId("projets-overview-row");
    const close = panel.getByRole("button", { name: "Fermer", exact: true });
    await expect(panel).toHaveCount(0);
    await card.click();
    await expect(card).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await expect(close).toBeFocused();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(active.projectDisplayName);
    await expect(rows.last()).toContainText(empty.projectDisplayName);
    await expect(panel.getByRole("alert")).toHaveText("Aperçu indisponible");
    await panel.getByRole("button", { name: "Réessayer", exact: true }).click();
    await expect(rows.first()).toContainText("En attente");
    await expect(rows.last()).toContainText("Sans tâche");
    await expect(panel.getByTestId("projets-overview-phases")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(card).toHaveAttribute("aria-expanded", "false");

    await write({ operation: "phase-add", phaseId: "sprint", title: "Sprint" });
    await write({ operation: "phase-status", phaseId: "sprint", status: "EN COURS" });
    await write({ operation: "add", phaseId: "sprint", taskId: "t1", title: "Première tâche" });
    await write({ operation: "add", phaseId: "sprint", taskId: "t2", title: "Deuxième tâche" });
    await write({ operation: "update", taskId: "t1", completed: true });
    await open.click();
    const track = rows.first().getByTestId("projets-overview-phases");
    await expect(rows.first()).toContainText("Sprint · 1/2");
    await expect(track).toHaveAccessibleName("Phase 1 · En attente, Sprint · En cours");
    await expect(rows.getByRole("button")).toHaveCount(0);
    await track.click();
    await expect(rows).toHaveCount(2);
    await expect(panel.getByText("Première tâche")).toHaveCount(0);
    await expect.poll(async () => (await panel.boundingBox())?.x).toBe(0);
    await page.getByTestId("projets-overview-backdrop").click({ position: { x: 1300, y: 48 } });
    await expect(open).toBeFocused();

    await page.setViewportSize({ width: 390, height: 780 });
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    await expect(open.or(menu).first()).toBeVisible();
    if (!(await open.isVisible())) {
      await menu.click();
      await page.getByRole("button", { name: "Projets", exact: true }).click();
    }
    await open.click();
    const name = rows.first().getByText(active.projectDisplayName, { exact: true });
    await expect(track).toBeVisible();
    await expect
      .poll(async () => (await track.boundingBox())!.y - (await name.boundingBox())!.y)
      .toBeGreaterThan(15);
    await close.click();
    await expect(panel).toHaveCount(0);
    await expect(open).toBeFocused();
  } finally {
    await client.removePlugin("projets").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.pluginsEnabled ?? false });
    await client.close();
    await empty.cleanup();
    await active.cleanup();
  }
});

test("Projets sends distinct lots and restores review after reconnecting", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "project-dispatch-", git: false });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const { config } = await client.getDaemonConfig();
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        socket.send(message);
        return;
      }
      const parsed = JSON.parse(message);
      const session = parsed.message ?? parsed;
      if (session.type === "list_provider_models_response" && session.payload.provider === "mock") {
        for (const model of session.payload.models ?? []) {
          model.isDefault = model.id === "ten-second-stream";
        }
      }
      socket.send(JSON.stringify(parsed));
    });
  });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(path.resolve(__dirname, "../../../../plugins/projets"));
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Projets", exact: true }).click();
    const list = page.getByTestId("projets-local-list");
    const queue = list.getByTestId("projets-queue");
    const names = ["Première tâche", "Deuxième tâche"];
    await list.getByRole("button", { name: /Ajouter une tâche/ }).click();
    const input = list.getByRole("textbox", { name: "Nouvelle tâche", exact: true });
    for (const name of names) {
      await input.fill(name);
      await input.press("Enter");
      await expect(list.getByRole("button", { name: "Modifier " + name })).toBeVisible();
    }
    await input.press("Escape");

    for (const name of names) {
      await list.getByRole("button", { name: "Modifier " + name }).hover();
      await list.getByRole("button", { name: "Actions de " + name }).click();
      await page.getByRole("menuitem", { name: "Ajouter à « À envoyer »" }).click();
      await expect(queue.getByText(name, { exact: true })).toBeVisible();
      if (name === names[0]) {
        await list.screenshot({ path: testInfo.outputPath("projets-a-envoyer.png") });
      }
      await queue.getByRole("button", { name: "Envoyer · 1" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "mock", exact: true }).click({ force: true });
      await dialog.getByRole("button", { name: "Lancer l’agent" }).click();
      await expect(queue.getByText(name, { exact: true })).toBeHidden();
    }
    await expect(list.getByTestId("projets-batch-running")).toHaveCount(2);
    await list.screenshot({ path: testInfo.outputPath("projets-en-cours.png") });
    await page.reload();
    const reviews = list.getByTestId("projets-batch-review");
    await expect(reviews).toHaveCount(2, { timeout: 25_000 });
    await list.screenshot({ path: testInfo.outputPath("projets-a-verifier.png") });
    for (const name of names) {
      await reviews.getByRole("checkbox", { name: "Valider " + name }).click();
    }
    await expect(reviews).toHaveCount(0);
    expect(
      (await client.fetchAgents()).entries.filter(
        ({ agent }) => agent.workspaceId === workspace.workspaceId && agent.provider === "mock",
      ),
    ).toHaveLength(2);
  } finally {
    await client.removePlugin("projets").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: config.pluginsEnabled ?? false });
    await client.close();
    await workspace.cleanup();
  }
});

async function dragOnBoard(
  page: import("@playwright/test").Page,
  source: import("@playwright/test").Locator,
  target: import("@playwright/test").Locator,
  axis: "x" | "y",
  position = 0.5,
) {
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const x = from.x + from.width * position;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (axis === "x" ? 12 : 0), y + (axis === "y" ? 12 : 0), { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await page.mouse.up();
}

async function addTask(
  page: import("@playwright/test").Page,
  title: string,
  notes = "",
  milestone = "",
) {
  await page.getByTestId("workspace-todos-new-title").filter({ visible: true }).fill(title);
  await page.getByTestId("workspace-todos-add-details").filter({ visible: true }).click();
  await page.getByTestId("workspace-todos-new-notes").filter({ visible: true }).fill(notes);
  await page.getByTestId("workspace-todos-new-milestone").filter({ visible: true }).fill(milestone);
  await page.getByTestId("workspace-todos-add").filter({ visible: true }).click();
  await expect(
    page.locator('[data-testid^="workspace-todo-label-"]').filter({ visible: true }).last(),
  ).toHaveText(title);
  await page.getByTestId("workspace-todos-add-details").filter({ visible: true }).click();
}

test("Jalons docks beside navigation, edits milestones, reorders tasks and preserves workspace drafts", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const first = await seedWorkspace({ repoPrefix: "todo-directory-", git: false });
  const second = await seedWorkspace({ repoPrefix: "todo-other-", git: false });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: first.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    const panel = page.getByTestId("workspace-todos-panel").filter({ visible: true });
    await expect(panel).toBeVisible();
    await addTask(
      page,
      "Prepare the shared plan",
      "Keep project steps visible to all agents.",
      "Delivery",
    );
    await addTask(page, "Validate the implementation", "", "Delivery");
    const saved = (await first.client.getWorkspaceTodos(first.workspaceId)).list;
    const id = saved.tasks[0]!.id,
      secondId = saved.tasks[1]!.id;
    expect(saved.tasks.map((task) => task.milestone)).toEqual(["Delivery", "Delivery"]);
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await expect(page.getByTestId(`workspace-todo-notes-${id}`)).toHaveValue(
      "Keep project steps visible to all agents.",
    );
    await page.getByTestId(`workspace-todo-title-${id}`).fill("Prepare the project plan");
    await page
      .getByTestId(`workspace-todo-notes-${id}`)
      .fill("These notes are protected from agent rewrites.");
    await page.getByTestId(`workspace-todo-save-${id}`).click();
    await expect(page.getByTestId(`workspace-todo-save-${id}`)).toBeHidden();
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
    await expect
      .poll(async () => (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks[0]?.id)
      .toBe(secondId);
    const dragHandle = page.getByTestId(`workspace-todo-drag-${secondId}`);
    const dragTarget = page.getByTestId(`workspace-todo-drag-${id}`);
    await expect(dragHandle).toBeVisible();
    await expect(dragTarget).toBeVisible();
    const handle = await dragHandle.boundingBox();
    const target = await dragTarget.boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(async () =>
        (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks.map((task) => task.id),
      )
      .toEqual([id, secondId]);
    await page.getByTestId(`workspace-todo-check-${id}`).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "1/2",
    );
    await expect(page.getByTestId(`workspace-todo-label-${id}`)).toBeHidden();
    await page.getByTestId("workspace-todo-completed-toggle-Delivery").click();
    await expect(page.getByTestId(`workspace-todo-label-${id}`)).toHaveText(
      "Prepare the project plan",
    );
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
    await expect(page.getByTestId(`workspace-todo-status-${secondId}`)).toHaveText("In progress");
    await page.getByTestId(`workspace-todo-notes-toggle-${secondId}`).click();
    await page.getByTestId(`workspace-todo-milestone-input-${secondId}`).fill("Verification");
    await page.getByTestId(`workspace-todo-save-${secondId}`).click();
    await expect(page.getByTestId("workspace-todo-milestone-Verification")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks[1]?.milestone,
      )
      .toBe("Verification");
    await page.getByTestId(`workspace-todo-notes-toggle-${secondId}`).click();
    await page.getByTestId("workspace-todos-new-title").fill("Draft survives workspace changes");
    await page.getByTestId("workspace-todos-close").click();
    await expect(panel).toBeHidden();
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-new-title")).toHaveValue(
      "Draft survives workspace changes",
    );
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: second.workspaceId,
    });
    await expect(panel).toBeHidden();
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "0/0",
    );
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: first.workspaceId,
    });
    await expect(
      page.getByTestId("workspace-todos-new-title").filter({ visible: true }),
    ).toHaveValue("Draft survives workspace changes");
    const box = await panel.boundingBox();
    const header = await page
      .getByTestId("workspace-header-title")
      .filter({ visible: true })
      .boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(header!.x);
    expect(box!.height).toBeGreaterThan(900);
    expect(box!.y).toBeLessThan(50);
    await page.screenshot({ path: testInfo.outputPath("workspace-todos-wide.png") });
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("workspace-todo-milestone-Verification")).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 650 });
    await expect
      .poll(async () => {
        const a = await panel.boundingBox();
        return Boolean(a && a.x >= 0 && a.y >= 0 && a.x + a.width <= 1000 && a.y + a.height <= 651);
      })
      .toBe(true);
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "Delete task", exact: true }).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "1/1",
    );
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("compact To-do sheet and revision conflict preserve the draft", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "todo-compact-" });
  try {
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-sheet").filter({ visible: true })).toBeVisible();
    await addTask(page, "Implement shared tasks", "A compact sheet uses the same project list.");
    const list = (await workspace.client.getWorkspaceTodos(workspace.workspaceId)).list;
    const id = list.tasks[0]!.id;
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await page.getByTestId(`workspace-todo-title-${id}`).fill("My unsaved title");
    await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, list.revision, {
      operation: "update",
      id,
      status: "in_progress",
    });
    await expect(page.getByTestId(`workspace-todo-status-${id}`)).toHaveText("In progress");
    await page.getByTestId(`workspace-todo-save-${id}`).click();
    await expect(page.getByTestId("workspace-todos-error").filter({ visible: true })).toContainText(
      "revision conflict",
    );
    await expect(page.getByTestId(`workspace-todo-title-${id}`)).toHaveValue("My unsaved title");
    await page.getByTestId("workspace-todos-retry").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-error").filter({ visible: true })).toBeHidden();
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await expect(page.getByTestId(`workspace-todo-notes-${id}`)).toHaveValue(
      "A compact sheet uses the same project list.",
    );
    await page.screenshot({ path: testInfo.outputPath("workspace-todos-compact.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("old hosts explain the To-do update requirement at entry", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "todo-old-host-" });
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        socket.send(message);
        return;
      }
      const parsed = JSON.parse(message);
      const session = parsed.message ?? parsed;
      if (session.type === "status" && session.payload?.status === "server_info")
        delete session.payload.features.workspaceTodoMilestones;
      socket.send(JSON.stringify(parsed));
    });
  });
  try {
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(
      page.getByTestId("workspace-todos-update-host").filter({ visible: true }),
    ).toContainText("Update this host");
  } finally {
    await workspace.cleanup();
  }
});

test("To-do observations resynchronize on reconnect without discarding text drafts", async ({
  page,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await seedWorkspace({ repoPrefix: "todo-reconnect-" });
  try {
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await addTask(page, "Reconnect the list");
    const list = (await workspace.client.getWorkspaceTodos(workspace.workspaceId)).list;
    const id = list.tasks[0]!.id;
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await page.getByTestId(`workspace-todo-title-${id}`).fill("Keep this local draft");
    await gate.drop();
    await gate.waitForBlockedConnection();
    await page.getByTestId(`workspace-todo-save-${id}`).click();
    await expect(page.getByTestId("workspace-todos-error")).toBeVisible();
    await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, list.revision, {
      operation: "update",
      id,
      status: "done",
    });
    await expect(page.getByTestId(`workspace-todo-title-${id}`)).toHaveValue(
      "Keep this local draft",
    );
    gate.restore();
    await expect(page.getByTestId(`workspace-todo-status-${id}`)).toHaveText("Done", {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`workspace-todo-title-${id}`)).toHaveValue(
      "Keep this local draft",
    );
  } finally {
    gate.restore();
    await workspace.cleanup();
  }
});

test("Jalons shows long titles in three real milestones without truncation", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "jalons-preview-", git: false });
  try {
    const initial = await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, 0, {
      operation: "initialize",
      tasks: [
        {
          title: "Clarifier les interactions et les couleurs de l’interface",
          notes: "Conserver les raccourcis clavier et les interactions tactiles.",
          milestone: "Interactions & interface",
        },
        {
          title: "Activer les profils de handoff dans la fenêtre de validation des plans",
          notes:
            "Vérifier la version active de l’interface et conserver les conversations ouvertes.",
          milestone: "Handoff & version locale",
        },
        {
          title: "Fiabiliser la publication et l’activation des versions locales",
          notes: "Comparer la version publiée, la version installée et celle réellement utilisée.",
          milestone: "Handoff & version locale",
        },
        {
          title: "Intégrer les réponses interactives et l’approfondissement dans les conversations",
          notes: "Vérifier le rendu sur desktop et sur petit écran.",
          milestone: "Conversations interactives",
        },
      ],
    });
    let revision = initial.revision;
    for (const [index, task] of initial.tasks.entries()) {
      const list = await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, revision, {
        operation: "update",
        id: task.id,
        status: index === 0 ? "done" : "in_progress",
      });
      revision = list.revision;
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(
      page.getByTestId("workspace-todo-milestone-Conversations interactives"),
    ).toBeVisible();
    const title = page.getByTestId(`workspace-todo-label-${initial.tasks[3]!.id}`);
    await expect(title).toHaveText(initial.tasks[3]!.title);
    expect(
      await title.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    await page.mouse.move(1350, 900);
    await page.getByTestId("workspace-header-title").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-hover-card")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("jalons-desktop.png") });
  } finally {
    await workspace.cleanup();
  }
});
