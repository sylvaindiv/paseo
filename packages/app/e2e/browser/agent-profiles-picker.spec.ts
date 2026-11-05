import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "../support/fixtures";
import {
  applyProfileFromPicker,
  closeModelPicker,
  expectComposerDoesNotName,
  expectAgentProfilesEmptyPrompt,
  expectProfileEditTooltip,
  expectComposerMode,
  expectCreateProfileFromModelRow,
  expectComposerModel,
  expectModelRowProfileActionBesideRow,
  expectModelRowSelected,
  expectProfileEditIsPencilOnly,
  expectProfileVisibleForProvider,
  openModelPicker,
  openAgentProfilesFromEmptyPrompt,
  seedAgentProfiles,
  seedModelProvider,
  selectModelRow,
} from "../support/helpers/agent-profiles";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";

const PROFILE = {
  id: "agent_profile_e2e_ui_work",
  name: "UI work",
  icon: "🎨",
  provider: "mock",
  model: "one-minute-stream",
  modeId: "approval-test",
  notes: "Use for UI work.",
  showInHandoff: false,
};

const PROFILE_SUMMARY = "Mock Load Test · One minute stream · Approval test";

async function measureComposerTyping(
  page: Page,
  prefix: string,
  scriptName = "profile-composer-typing.mjs",
  environment: Record<string, string> = {},
) {
  const statePath = `${prefix}-state.json`;
  await page.context().storageState({ path: statePath });
  // Run the existing benchmark against this worker's isolated host and browser state.
  const original = await readFile(path.resolve("scripts", scriptName), "utf8");
  const script = original
    .replace(
      "chromium.launch({ headless })",
      "chromium.launch({ headless, channel: process.env.PASEO_PROFILE_BROWSER_CHANNEL || undefined })",
    )
    .replace(
      "browser.newPage({ viewport: { width: 1440, height: 1000 } })",
      "browser.newPage({ viewport: { width: 1440, height: 1000 }, storageState: process.env.PASEO_PROFILE_STORAGE_STATE })",
    );
  const scriptPath = `${prefix}.mjs`;
  await writeFile(scriptPath, script);
  const { stdout } = await promisify(execFile)(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      PASEO_PROFILE_APP_URL: new URL(page.url()).origin,
      PASEO_PROFILE_STORAGE_STATE: statePath,
      PASEO_PROFILE_BROWSER_CHANNEL:
        test.info().project.use.channel ?? test.info().project.use.launchOptions?.channel ?? "",
      PASEO_PROFILE_TYPING_KEYS: "60",
      PASEO_PROFILE_TYPING_REPEATS: "1",
      ...environment,
    },
    timeout: 60_000,
    maxBuffer: 2_000_000,
  });
  return JSON.parse(stdout);
}

async function delayProfileRequests(page: Page, delayMs: number) {
  const stats = { requests: 0 };
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage(async (message) => {
      const envelope = JSON.parse(String(message));
      if (envelope.type === "session" && envelope.message?.type === "agent.config.apply.request") {
        stats.requests++;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
  return stats;
}

async function measureProfileCycle(element: HTMLElement) {
  const samples: number[] = [];
  const longTasks: number[] = [];
  const requests: { at: number; label: string }[] = [];
  const changes: string[] = [];
  let skipped = 0;
  const currentLabel = () =>
    document.querySelector('[aria-label^="Select model ("]')?.getAttribute("aria-label") ?? "";
  let lastLabel = currentLabel();
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  observer.observe({ type: "longtask" });
  const mutations = new MutationObserver(() => {
    const label = currentLabel();
    if (!label || label === lastLabel) return;
    lastLabel = label;
    const index = requests.findIndex((request) => request.label === label);
    if (index < 0) return;
    skipped += index;
    const [request] = requests.splice(0, index + 1).slice(-1);
    changes.push(label);
    samples.push(performance.now() - request.at);
  });
  mutations.observe(document.body, { subtree: true, attributes: true, childList: true });
  element.focus();
  try {
    for (let i = 0; i < 20; i++) {
      requests.push({
        at: performance.now(),
        label: `Select model (${i % 2 === 0 ? "One minute stream" : "Ten second stream"})`,
      });
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }),
      );
      element.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    mutations.disconnect();
    observer.disconnect();
  }
  samples.sort((a, b) => a - b);
  return {
    changes,
    samples,
    skipped: skipped + requests.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.ceil(samples.length * 0.95) - 1],
    longTasks,
  };
}

test.describe("Agent profiles in the model picker", () => {
  for (const delayMs of [0, 150]) {
    test(`rapid Tab keeps every selection with ${delayMs}ms host latency`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const configRequests = await delayProfileRequests(page, delayMs);
      const seed = await seedAgentProfiles([
        { ...PROFILE, id: "perf-a", model: "one-minute-stream" },
        { ...PROFILE, id: "perf-b", model: "ten-second-stream" },
      ]);
      const workspace = await seedMockAgentWorkspace({
        repoPrefix: "profile-perf-",
        title: "Profile performance",
        model: "e2e-fast-stream",
      });
      try {
        await openAgentRoute(page, workspace);
        await expectComposerVisible(page);
        const input = page.getByRole("textbox", { name: "Message agent..." });
        await input.fill("Keep this draft");
        const report = await input.evaluate(measureProfileCycle);
        console.log(
          "PROFILE_PERF",
          JSON.stringify({ delayMs, configRequests: configRequests.requests, ...report }),
        );
        await testInfo.attach("profile-latency.json", {
          body: JSON.stringify(report),
          contentType: "application/json",
        });
        expect(report.skipped).toBe(0);
        expect(report.changes).toHaveLength(20);
        await expectComposerModel(page, "Ten second stream");
        await expect(input).toBeFocused();
        await expect(input).toHaveValue("Keep this draft");
        await expect(page.getByTestId("agent-profile-applying")).toHaveCount(0);
        await expectWorkspaceAgentConfiguration(workspace, {
          provider: "mock",
          model: "ten-second-stream",
          modeId: "approval-test",
        });
        await page.screenshot({ path: testInfo.outputPath("rapid-tab.png") });
        const typing = await measureComposerTyping(page, testInfo.outputPath("typing"));
        console.log("TYPING_PERF", JSON.stringify(typing));
        await testInfo.attach("typing-latency.json", {
          body: JSON.stringify(typing),
          contentType: "application/json",
        });
      } finally {
        await workspace.cleanup();
        await seed.restore();
      }
    });
  }

  test("daily navigation and typing remain responsive during streaming", async ({
    page,
    e2eWorkerClient,
  }, testInfo) => {
    test.setTimeout(180_000);
    const first = await seedMockAgentWorkspace({
      repoPrefix: "daily-first-",
      title: "First conversation",
      model: "one-minute-stream",
    });
    const second = await seedMockAgentWorkspace({
      repoPrefix: "daily-second-",
      title: "Second conversation",
      model: "one-minute-stream",
    });
    try {
      await openAgentRoute(page, first);
      await expectComposerVisible(page);
      const navigation = await measureComposerTyping(
        page,
        testInfo.outputPath("navigation"),
        "profile-workspace-switching.mjs",
        {
          PASEO_PROFILE_WORKSPACE_DIGITS: "21",
          PASEO_PROFILE_RETAINED_REPEATS: "3",
        },
      );
      console.log("NAVIGATION_PERF", JSON.stringify(navigation));
      await testInfo.attach("navigation.json", {
        body: JSON.stringify(navigation),
        contentType: "application/json",
      });
      await e2eWorkerClient.sendAgentMessage(first.agentId, "Stream benchmark");
      await e2eWorkerClient.sendAgentMessage(second.agentId, "Stream benchmark");
      const typing = await measureComposerTyping(page, testInfo.outputPath("stream-typing"));
      console.log("STREAM_TYPING_PERF", JSON.stringify(typing));
      await testInfo.attach("stream-typing.json", {
        body: JSON.stringify(typing),
        contentType: "application/json",
      });
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("a failed profile shows the applied settings and lets Tab recover", async ({
    page,
  }, testInfo) => {
    const seed = await seedAgentProfiles([
      { ...PROFILE, id: "partial-failure", featureValues: { unsupported: true } },
      { ...PROFILE, id: "recovery", model: "ten-second-stream" },
    ]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "profile-failure-",
      title: "Profile recovery",
      model: "e2e-fast-stream",
    });
    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.fill("Keep this draft");
      await page.keyboard.press("Tab");
      await expect(
        page.getByText("Agent session does not support setting features", { exact: true }).first(),
      ).toBeVisible();
      await expectComposerModel(page, "One minute stream");
      await expect(page.getByTestId("agent-profile-applying")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("profile-error.png") });
      await page.keyboard.press("Tab");
      await expectComposerModel(page, "Ten second stream");
      await expect(page.getByTestId("agent-profile-applying")).toHaveCount(0);
      await expect(input).toHaveValue("Keep this draft");
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "ten-second-stream",
        modeId: "approval-test",
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("Shift+Tab still toggles plan after Tab and leaves the background agent unchanged", async ({
    page,
  }, testInfo) => {
    const provider = await seedModelProvider({
      id: "shortcut-models",
      label: "Shortcut models",
      models: [{ id: "fast", label: "Fast model", description: "Keyboard test model" }],
    });
    const seed = await seedAgentProfiles([
      {
        id: "shortcut-profile",
        name: "Fast work",
        provider: "shortcut-models",
        model: "fast",
        modeId: "bypassPermissions",
      },
    ]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "profile-tab-background-",
      title: "Background agent",
      model: "ten-second-stream",
    });
    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, workspace);
      await openModelPicker(page);
      await expect(page.getByText("Fast work", { exact: true })).toBeVisible();
      await closeModelPicker(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.click();
      await input.fill("Keep the draft focused");
      await expect(input).toBeFocused();
      await page.keyboard.press("Tab");
      await expectComposerModel(page, "Fast model");
      await expect(input).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("message-input-plan-stripe")).toBeVisible();
      await expect(input).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("plan-after-tab.png") });
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("message-input-plan-stripe")).toHaveCount(0);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Keep the draft focused");
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "ten-second-stream",
        modeId: "load-test",
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
      await provider.restore();
    }
  });

  test("Tab cycles profiles without losing composer focus or consuming autocomplete", async ({
    page,
  }, testInfo) => {
    const seed = await seedAgentProfiles([
      PROFILE,
      { ...PROFILE, id: "agent_profile_second", name: "Quick work", model: "ten-second-stream" },
    ]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profile-tab-",
      title: "Profile keyboard shortcuts",
      model: "e2e-fast-stream",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.fill("Keep this draft");
      await page.keyboard.press("Tab");
      await expectComposerModel(page, "One minute stream");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Keep this draft");

      for (const modifiers of [
        { altKey: true },
        { ctrlKey: true },
        { metaKey: true },
        { isComposing: true },
      ]) {
        await input.dispatchEvent("keydown", { key: "Tab", code: "Tab", ...modifiers });
      }
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      });

      await page.keyboard.down("Tab");
      await expectComposerModel(page, "Ten second stream");
      await page.keyboard.down("Tab");
      await page.keyboard.up("Tab");
      await expect(input).toBeFocused();
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "ten-second-stream",
        modeId: "approval-test",
      });

      await page.keyboard.press("Tab");
      await expectComposerModel(page, "One minute stream");
      await expect(input).toBeFocused();

      await input.fill("@README");
      await expect(
        page.getByTestId("composer-autocomplete-popover").getByText("README.md", { exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("composer-autocomplete-popover")).not.toBeVisible();
      await expect(input).toBeFocused();
      await expectWorkspaceAgentConfiguration(workspace, {
        provider: "mock",
        model: "one-minute-stream",
        modeId: "approval-test",
      });
      await input.fill("");
      await page.evaluate(() => {
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ language: "fr", theme: "light" }),
        );
      });
      await page.reload();
      const frenchInput = page.getByTestId("message-input-surface").getByRole("textbox");
      await expect(frenchInput).toBeVisible();
      await frenchInput.fill("");
      await page.screenshot({ path: testInfo.outputPath("french-composer.png") });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("an empty host still exposes agent profile settings from the picker", async ({ page }) => {
    const seed = await seedAgentProfiles([]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-empty-",
      title: "Agent profiles empty",
    });

    try {
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      const input = page.getByRole("textbox", { name: "Message agent..." });
      await input.click();
      await page.keyboard.press("Tab");
      await expect(input).not.toBeFocused();
      await openModelPicker(page);
      await expectAgentProfilesEmptyPrompt(page);
      await openAgentProfilesFromEmptyPrompt(page);
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("applying a pinned profile materializes it into the composer and is then forgotten", async ({
    page,
  }) => {
    const seed = await seedAgentProfiles([PROFILE]);
    // A live agent is one provider's process, so the profile has to name that
    // same provider or the picker will not offer it at all.
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-picker-",
      title: "Agent profiles picker",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      await test.step("the agent starts on its seeded model and mode", async () => {
        await openAgentRoute(page, workspace);
        await expectComposerVisible(page);
        await expectComposerModel(page, "Ten second stream");
        await expectComposerMode(page, "Load test");
      });

      await test.step("the sole provider opens directly", async () => {
        await openModelPicker(page);
        await expect(page.getByTestId("model-search-input").first()).toBeVisible();
        await expect(page.getByTestId("sheet-header-back")).toHaveCount(0);
        await expect(page.locator('[data-testid^="model-provider-"]')).toHaveCount(0);
        await expectProfileVisibleForProvider(page, {
          name: PROFILE.name,
          summary: PROFILE_SUMMARY,
        });
        await expectProfileEditIsPencilOnly(page);
        await expectProfileEditTooltip(page);
      });

      await test.step("applying it writes its model and mode into the composer", async () => {
        await applyProfileFromPicker(page, PROFILE.name);
        await expectComposerModel(page, "One minute stream");
        await expectComposerMode(page, "Approval test");
        await expectWorkspaceAgentConfiguration(workspace, {
          id: workspace.agentId,
          provider: "mock",
          model: "one-minute-stream",
          modeId: "approval-test",
        });
      });

      await test.step("the composer names the model, never the profile", async () => {
        await expectComposerDoesNotName(page, PROFILE.name);
      });

      await test.step("reopening returns directly to the provider models", async () => {
        await openModelPicker(page);
        await expect(page.getByTestId("model-search-input").first()).toBeVisible();
        await expectProfileVisibleForProvider(page, {
          name: PROFILE.name,
          summary: PROFILE_SUMMARY,
        });
        await expectModelRowSelected(page, { provider: "mock", modelId: "one-minute-stream" });
        await closeModelPicker(page);
      });
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });

  test("a model row and its create-profile action are separate buttons", async ({ page }) => {
    const seed = await seedAgentProfiles([]);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "agent-profiles-row-action-",
      title: "Agent profiles row action",
      model: "ten-second-stream",
      modeId: "load-test",
    });

    try {
      const oneMinute = {
        provider: "mock",
        modelId: "one-minute-stream",
        modelLabel: "One minute stream",
      };
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      await openModelPicker(page);
      await expectModelRowProfileActionBesideRow(page, oneMinute);
      await expectCreateProfileFromModelRow(page, oneMinute);
      await expectComposerModel(page, "Ten second stream");
      await openModelPicker(page);
      await selectModelRow(page, oneMinute);
      await expectComposerModel(page, oneMinute.modelLabel);
    } finally {
      await workspace.cleanup();
      await seed.restore();
    }
  });
});
