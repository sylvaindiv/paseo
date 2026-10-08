import { expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  expectAddProjectPage,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  closeSidebarDisplayPreferences,
  openSidebarProjectFilter,
  pinWorkspaceFromSidebar,
  selectAllProjectsFilter,
  selectSidebarStatusGrouping,
  toggleProjectFilter,
} from "../support/helpers/sidebar";

test.describe("Sidebar project filter", () => {
  test.describe.configure({ timeout: 180_000 });

  for (const method of ["directory-search", "new-directory"] as const) {
    test(`includes a project added through ${method} without revealing excluded projects`, async ({
      page,
    }, testInfo) => {
      const alpha = await seedWorkspace({ repoPrefix: "filter-kept-", title: "Kept work" });
      const beta = await seedWorkspace({ repoPrefix: "filter-hidden-", title: "Hidden work" });
      const parent = await mkdtemp(path.join(tmpdir(), "filter-added-"));
      const client = await connectSeedClient();
      const serverId = getServerId();
      const alphaRow = page.getByTestId(`sidebar-project-row-${alpha.projectKey}`);
      const betaRow = page.getByTestId(`sidebar-project-row-${beta.projectKey}`);
      const projectName = method === "new-directory" ? "Created project" : path.basename(parent);
      let projectId: string | null = null;

      try {
        await gotoAppShell(page);
        await expect(alphaRow).toBeVisible({ timeout: 30_000 });
        await expect(betaRow).toBeVisible({ timeout: 30_000 });
        await openSidebarProjectFilter(page);
        await toggleProjectFilter(page, alpha.projectKey);
        await closeSidebarDisplayPreferences(page);
        await expect(betaRow).toHaveCount(0);

        await openAddProjectFlow(page);
        await chooseAddProjectMethod(page, method);
        await addProjectFlowInput(page).fill(parent);
        await page.keyboard.press("Enter");
        if (method === "new-directory") {
          await expectAddProjectPage(page, "new-directory-name");
          await addProjectFlowInput(page).fill(projectName);
          await page.keyboard.press("Enter");
        }
        projectId = await expectOpenedProject(page);

        const addedRow = page
          .locator('[data-testid^="sidebar-project-row-"]')
          .filter({ hasText: projectName });
        await expect(addedRow).toBeVisible({ timeout: 30_000 });
        await expect(alphaRow).toBeVisible();
        await expect(betaRow).toHaveCount(0);

        await page.reload();
        await expect(addedRow).toBeVisible({ timeout: 30_000 });
        await expect(alphaRow).toBeVisible();
        await expect(betaRow).toHaveCount(0);
        await expect(
          page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`),
        ).toBeVisible();
        const addedRowId = await addedRow.getAttribute("data-testid");
        expect(addedRowId).not.toBeNull();
        const addedViewKey = addedRowId!.slice("sidebar-project-row-".length);
        await openSidebarProjectFilter(page);
        await expect(page.getByTestId(`sidebar-project-filter-${addedViewKey}`)).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await expect(
          page.getByTestId(`sidebar-project-filter-${alpha.projectKey}`),
        ).toHaveAttribute("aria-checked", "true");
        await expect(page.getByTestId(`sidebar-project-filter-${beta.projectKey}`)).toHaveAttribute(
          "aria-checked",
          "false",
        );
        await page.screenshot({ path: testInfo.outputPath("project-selection.png") });
      } finally {
        if (projectId) await client.removeProject(projectId);
        await client.close();
        await rm(parent, { recursive: true, force: true });
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  }

  test("keeps the project selection when adding a missing directory fails", async ({ page }) => {
    const alpha = await seedWorkspace({ repoPrefix: "filter-kept-" });
    const beta = await seedWorkspace({ repoPrefix: "filter-hidden-" });
    const alphaRow = page.getByTestId(`sidebar-project-row-${alpha.projectKey}`);
    const betaRow = page.getByTestId(`sidebar-project-row-${beta.projectKey}`);

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible({ timeout: 30_000 });
      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "directory-search");
      await addProjectFlowInput(page).fill(path.join(alpha.repoPath, "missing-directory"));
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("add-project-flow-error")).toHaveText("Directory not found");
      await expectAddProjectPage(page, "directory-search");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0);
      await page.reload();
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toHaveCount(0);
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("pins the sidebar to one project across both grouping modes", async ({ page }) => {
    // Two temp repos means two projects, which is also what makes the `Project ›` row appear.
    const alpha = await seedWorkspace({ repoPrefix: "project-filter-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-beta-", title: "Beta work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);
    const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);
    const filterTrigger = page.getByTestId("sidebar-display-project-filter");

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible({ timeout: 30_000 });

      await openSidebarProjectFilter(page);
      await expect(page.getByTestId("sidebar-project-filter-all")).toBeVisible();
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0, { timeout: 10_000 });

      // The indicator reads the filter as it is applied, so it must be on here.
      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(filterTrigger).toBeVisible();
      await expect(filterTrigger.getByTestId("menu-sub-indicator")).toBeVisible();
      await closeSidebarDisplayPreferences(page);

      // Status grouping builds its rows from the workspace entries rather than the projects
      // array, so a filter applied in only one of the two places passes every check above and
      // silently fails right here.
      await selectSidebarStatusGrouping(page);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toBeVisible({ timeout: 15_000 });
      await expect(betaRow).toHaveCount(0);

      // The filter is view state and survives a cold load.
      await page.reload();
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toHaveCount(0);

      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toBeVisible({ timeout: 15_000 });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("keeps the display menu reachable when the pinned section swallows the filtered project", async ({
    page,
  }) => {
    // Pinning hoists a chat out of its project, and a project whose chats are ALL hoisted is
    // dropped from the project list entirely. Filter to that project and the list body has no
    // project rows left — so the header, which carries the only route back to the filter page,
    // has to survive on the strength of the filter alone.
    const alpha = await seedWorkspace({
      repoPrefix: "project-filter-pinned-",
      title: "Pinned work",
    });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-other-", title: "Other work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });

      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await pinWorkspaceFromSidebar(page, alpha.workspaceId);
      await expect(alphaRow).toBeVisible();

      // The way out of the filter is still on screen.
      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("hides the filter row when there is only one project", async ({ page }) => {
    const only = await seedWorkspace({ repoPrefix: "project-filter-solo-", title: "Solo work" });
    const serverId = getServerId();

    try {
      await gotoAppShell(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${only.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible();
      await expect(page.getByTestId("sidebar-display-project-filter")).toHaveCount(0);
    } finally {
      await only.cleanup();
    }
  });
});
