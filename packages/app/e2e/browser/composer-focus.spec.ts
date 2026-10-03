import { expect, test } from "../support/fixtures";
import {
  expectComposerDraft,
  expectComposerFocused,
  expectComposerVisible,
  submitMessage,
  typeIntoFocusedComposer,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("submitting a message leaves the composer ready for the next message", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "composer-focus-",
    title: "Composer focus",
  });

  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    await submitMessage(page, "First message");
    await expectComposerFocused(page);

    await typeIntoFocusedComposer(page, "Second message");
    await expectComposerDraft(page, "Second message");
  } finally {
    await agent.cleanup();
  }
});

test("opening Explorer keeps the agent composer focused while its shell starts", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "explorer-composer-focus-",
    title: "Explorer composer focus",
  });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, agent);
    const composer = page
      .locator("textarea[data-composer-input]")
      .filter({ visible: true })
      .first();
    await expect(composer).toBeEditable({ timeout: 30_000 });
    await composer.focus();
    await expect(composer).toBeFocused();

    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="workspace-explorer-toggle"]')?.click();
    });
    const explorer = page.getByTestId("workspace-explorer-sidebar");
    await expect(explorer.getByTestId("terminal-surface")).toBeVisible({ timeout: 30_000 });
    await expect(explorer.getByTestId("terminal-attach-loading")).toBeHidden();
    await page.waitForTimeout(200);
    await expect(composer).toBeFocused();
  } finally {
    await agent.cleanup();
  }
});
