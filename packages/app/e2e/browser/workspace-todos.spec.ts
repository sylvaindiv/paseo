import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

test.use({ video: "off", trace: "off" });

async function addTask(page: import("@playwright/test").Page, title: string, notes = "") {
  await page.getByTestId("workspace-todos-new-title").filter({ visible: true }).fill(title);
  await page.getByTestId("workspace-todos-new-notes").filter({ visible: true }).fill(notes);
  await page.getByTestId("workspace-todos-add").filter({ visible: true }).click();
  await expect(
    page.locator('[data-testid^="workspace-todo-title-"]').filter({ visible: true }).last(),
  ).toHaveValue(title);
}

test("shared To-do edits, ordering, drafts, workspace isolation and constrained window", async ({
  page,
}, testInfo) => {
  const first = await seedWorkspace({ repoPrefix: "todo-directory-", git: false });
  const second = await seedWorkspace({ repoPrefix: "todo-other-", git: false });
  try {
    await page.setViewportSize({ width: 1280, height: 850 });
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: first.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    const panel = page.getByTestId("workspace-todos-panel").filter({ visible: true });
    await expect(panel).toBeVisible();
    await addTask(page, "Prepare the shared plan", "Keep project steps visible to all agents.");
    await addTask(page, "Validate the implementation");
    const saved = (await first.client.getWorkspaceTodos(first.workspaceId)).list;
    const id = saved.tasks[0]!.id;
    const secondId = saved.tasks[1]!.id;
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
    await page.getByTestId(`workspace-todo-check-${id}`).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "1/2",
    );
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
    await expect(page.getByTestId(`workspace-todo-status-${secondId}`)).toHaveText("In progress");
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
    await expect
      .poll(async () => (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks[0]?.id)
      .toBe(secondId);
    const handle = await page.getByTestId(`workspace-todo-drag-${secondId}`).boundingBox();
    const target = await page.getByTestId(`workspace-todo-drag-${id}`).boundingBox();
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
    await expect(
      page.locator('[data-testid^="workspace-todo-title-"]').filter({ visible: true }).first(),
    ).toHaveValue("Prepare the project plan");
    await page
      .getByTestId("workspace-todos-new-title")
      .filter({ visible: true })
      .fill("Draft survives workspace changes");
    await page.getByTestId("workspace-todos-close").filter({ visible: true }).click();
    await expect(panel).toBeHidden();
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(
      page.getByTestId("workspace-todos-new-title").filter({ visible: true }),
    ).toHaveValue("Draft survives workspace changes");
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
    await expect(panel).toBeVisible();
    await expect(
      page.getByTestId("workspace-todos-new-title").filter({ visible: true }),
    ).toHaveValue("Draft survives workspace changes");
    const beforeDrag = await panel.boundingBox();
    const header = await page
      .getByTestId("workspace-todos-drag-header")
      .filter({ visible: true })
      .boundingBox();
    await page.mouse.move(header!.x + 60, header!.y + 18);
    await page.mouse.down();
    await page.mouse.move(20, 800, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return Boolean(box && beforeDrag && box.x < beforeDrag.x - 20 && box.y > beforeDrag.y + 20);
      })
      .toBe(true);
    await page.setViewportSize({ width: 1000, height: 650 });
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return (
          box !== null &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= 1000 &&
          box.y + box.height <= 651
        );
      })
      .toBe(true);
    // Clicking workspace content leaves the nonmodal window open.
    await page.getByTestId("workspace-header-title").filter({ visible: true }).click();
    await expect(panel).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("workspace-todos-wide.png") });
    const beforeReload = await panel.boundingBox();
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "1/2",
    );
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return Boolean(
          box &&
          beforeReload &&
          Math.abs(box.x - beforeReload.x) < 1 &&
          Math.abs(box.y - beforeReload.y) < 1,
        );
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
        delete session.payload.features.workspaceTodos;
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
