import { expect, test } from "../support/fixtures";
import { waitForPermissionPrompt } from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

function getTextLineBounds(element: Element) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const { top, bottom, width } = range.getBoundingClientRect();
      return { text: node.textContent, top, bottom, width };
    });
}

// The plan card has to pass its own markdown parser. Drop that prop and
// react-native-markdown-display silently supplies one with `typographer: true`
// (node_modules/react-native-markdown-display/src/index.js:139-141), which
// turns (c) into ©, curls straight quotes, and rewrites --- as an em dash.
// No unit test can catch that, because the defect lives in the JSX.
//
// Nothing here is provider-specific: the mock provider drives it, and the
// behavior is the same for every agent.
test.describe("Plan card markdown", () => {
  test("renders plan text verbatim and draws Mermaid fences", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "plan-card-markdown-",
      title: "Plan card markdown e2e",
      initialPrompt: "Emit synthetic plan approval with the CVC diagram.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForPermissionPrompt(page, 120_000);

      const planCard = page.getByTestId("timeline-plan-card");
      await expect(planCard).toContainText("(c)");
      await expect(planCard).toContainText('--name="my repo"');
      await expect(planCard).toContainText("---buzz");
      await expect(planCard).not.toContainText("©");
      await expect(planCard).not.toContainText("—buzz");
      await expect(planCard).toContainText('printf "%s\\n" "Confort et CVC"');

      const diagram = planCard.getByRole("img", { name: "Diagram" });
      const svg = diagram.locator("iframe").contentFrame().locator("#diagram svg");
      await expect(diagram).toBeVisible({ timeout: 30_000 });
      await expect(svg.getByText("Accueil", { exact: true })).toBeVisible();
      await expect(svg.getByText("Prestations", { exact: true })).toBeVisible();
      await expect(svg.locator('path.flowchart-link[data-id="L_A_P_0"]')).toBeVisible();
      const label = svg.locator(".nodeLabel p").filter({ hasText: "Nettoyage intérieur" });
      await expect(label).toBeVisible();
      const lines = await label.evaluate(getTextLineBounds);
      expect(lines.map((line) => line.text)).toEqual(["Nettoyage intérieur", "Confort et CVC"]);
      expect(lines.every((line) => line.width > 0)).toBe(true);
      expect(lines[1]!.top).toBeGreaterThanOrEqual(lines[0]!.bottom);

      const toggle = planCard.getByRole("button", { name: "Plan", exact: true });
      await toggle.click();
      await expect(diagram).toHaveCount(0);
      await toggle.click();
      await expect(diagram).toBeVisible({ timeout: 30_000 });
      await expect(svg.getByText("Prestations", { exact: true })).toBeVisible();
      await testInfo.attach("CVC plan", {
        body: await planCard.screenshot(),
        contentType: "image/png",
      });
    } finally {
      await session.cleanup();
    }
  });
});
