import type { Locator } from "@playwright/test";
import { scrollTimelineToOldestLoadedEdge } from "../support/helpers/timeline-pagination";
import { gateNextAgentMessage } from "../support/helpers/agent-message-gate";
import { extractInteractiveDocumentId } from "@getpaseo/protocol/interactive-response-reference";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test as base } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

const test = base.extend({
  e2eInjectPaseoTools: [true, { scope: "worker" }],
});
const input = {
  title: "Choose your plan",
  summary: "Compare the plans and send your choice.",
  source:
    'root = Layout([Text("A plan for this project"), Comparison(["Plan", "Price"], [["Basic", "10"], ["Pro", "20"]]), Selection("plan", "Your plan", ["Basic", "Pro"]), Input("notes", "Notes"), BarChart([{label:"Basic",value:10},{label:"Pro",value:20}], "Monthly price")])',
};
test("interactive responses persist selections and send snapshots before deepening a historical answer", async ({
  page,
}, info) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-",
    title: "Interactive responses",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify(input)}`,
    featureValues: { mockAssistantResponse: "The chosen plan is recorded." },
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "interactive-check" });
  try {
    await client.waitForFinish(session.agentId, 15000);
    const generated = await client.fetchAgentTimeline(session.agentId, { limit: 200 });
    await info.attach("generated-timeline", {
      body: JSON.stringify(generated, null, 2),
      contentType: "application/json",
    });
    expect(JSON.stringify(generated)).toContain("documentId");
    await page.setViewportSize({ width: 1200, height: 1400 });
    const gate = await gateNextAgentMessage(page);
    await openAgentRoute(page, session);
    const card = page.getByTestId("interactive-response");
    await expect(card).toContainText(input.title);
    const tool = generated.entries.find((entry) => entry.item.type === "tool_call");
    const documentId =
      tool?.item.type === "tool_call" && tool.item.detail.type === "unknown"
        ? extractInteractiveDocumentId(tool.item.detail.output)
        : null;
    expect(documentId).not.toBeNull();
    await client.updateInteractiveResponse(session.agentId, documentId!, 0, { plan: "Basic" });
    await card.getByRole("button", { name: "Pro", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("revision conflict");
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({ path: info.outputPath("interactive-conflict.png") });
    await card.getByRole("button", { name: "Reload", exact: true }).click();
    await card.getByRole("button", { name: "Pro", exact: true }).click();
    await card.getByRole("textbox", { name: "Notes" }).fill("For the team");
    await expect(card.getByText("Monthly price", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Send to agent", exact: true }).click();
    await gate.waitForRequest();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toHaveCount(0);
    gate.accept();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({
      path: info.outputPath("interactive-desktop.png"),
      animations: "disabled",
    });
    await page.reload();
    await expect(card).toContainText(input.title);
    await expect(card.getByRole("textbox", { name: "Notes" })).toHaveValue("For the team");
    await page.getByRole("button", { name: "Explore further", exact: true }).first().click();
    await gate.waitForRequest(2);
    gate.accept(1);
    await expect(page.getByText("Explore this response:", { exact: false }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await scrollTimelineToOldestLoadedEdge(page);
    await expect(card).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1400 });
    await scrollTimelineToOldestLoadedEdge(page);
    await card.screenshot({ path: info.outputPath("interactive-mobile-web.png") });
    const timeline = await client.fetchAgentTimeline(session.agentId, { limit: 200 });
    expect(JSON.stringify(timeline)).toContain("Selection received:");
    expect(JSON.stringify(timeline)).toContain("For the team");
    expect(timeline.agent?.model).toBe("e2e-fast-stream");
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("@paseo:app-settings") ?? "{}");
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ ...settings, theme: "pureBlack" }),
      );
    });
    await page.setViewportSize({ width: 1200, height: 1400 });
    await page.reload();
    await scrollTimelineToOldestLoadedEdge(page);
    await expect(card).toBeVisible();
    await card.screenshot({ path: info.outputPath("interactive-dark.png") });
  } catch (error) {
    await page.screenshot({ path: info.outputPath("interactive-failure.png") });
    throw error;
  } finally {
    await client.close();
    await session.cleanup();
  }
});

test("custom JavaScript restores state, filters dynamic markup and sends only after confirmation", async ({
  page,
}, info) => {
  const script = `let count=paseo.getState()?.count??2;
function draw(){paseo.render('<style>button{padding:12px;border-radius:8px}</style><h2>Project calculator</h2><button id="add">Add: '+count+'</button><input id="amount" type="range" min="0" max="10" value="'+count+'"><textarea id="note" aria-label="Note"></textarea><img src="https://example.com/paseo-artifact-exfil"><div onclick="parent.postMessage(1)" id="dynamic">Offline</div>')}
function save(){paseo.setState({count});paseo.propose('Choose '+count);draw()}
draw();paseo.on('add','click',()=>{count++;save()});paseo.on('amount','input',event=>{count=Number(event.value);save()});paseo.on('note','input',event=>paseo.propose(event.value));
if([typeof fetch,typeof parent,typeof document,typeof WebSocket,typeof process].some(value=>value!=='undefined')) throw Error('Host access');`;
  const html = "<script>" + script + "</script>";
  const source = `root = Layout([HtmlArtifact(${JSON.stringify(html)})])`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-script-",
    title: "Custom visual",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify({ title: "Project calculator", summary: "Adjust and confirm", source })}`,
    featureValues: { mockAssistantResponse: "Choice received." },
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "interactive-script" });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("paseo-artifact-exfil")) requests.push(request.url());
  });
  try {
    await page.setViewportSize({ width: 2560, height: 1100 });
    await openAgentRoute(page, session);
    const card = page.getByTestId("interactive-response");
    const frame = page.getByTitle("HTML visual", { exact: true });
    const visual = frame.contentFrame();
    await visual.getByRole("button", { name: "Add: 2", exact: true }).click();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await expect(card.getByText("Choose 3", { exact: true })).toBeVisible();
    await visual.getByRole("textbox", { name: "Note" }).fill("A multiline note");
    await expect(card.getByText("A multiline note", { exact: true })).toBeVisible();
    await visual.getByRole("slider").focus();
    await visual.getByRole("slider").press("ArrowRight");
    await expect(visual.getByRole("button", { name: "Add: 4", exact: true })).toBeVisible();
    await expect(visual.getByRole("slider")).toBeFocused();
    await visual.getByRole("slider").press("ArrowLeft");
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    const slider = visual.getByRole("slider");
    const bounds = await slider.boundingBox();
    if (!bounds) throw new Error("Missing slider bounds");
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 0.5, y);
    await expect(visual.getByRole("button", { name: "Add: 5", exact: true })).toBeVisible();
    await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 0.9, y);
    await page.mouse.up();
    await expect(visual.getByRole("button", { name: "Add: 9", exact: true })).toBeVisible();
    await slider.press("Home");
    await expect(visual.getByRole("button", { name: "Add: 0", exact: true })).toBeVisible();
    for (const value of [1, 2, 3]) {
      await slider.press("ArrowRight");
      await expect(
        visual.getByRole("button", { name: `Add: ${value}`, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByText("Selection received:", { exact: false })).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator('iframe[title="HTML visual"]')).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await page.reload();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await expect(card.getByText("Choose 3", { exact: true })).toBeVisible();
    await page.evaluate(() => window.postMessage({ type: "state", value: "forged" }, "*"));
    await expect(card).not.toContainText("forged");

    const todos = page.getByTestId("workspace-todos-panel").filter({ visible: true });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(todos).toBeVisible();
    const message = page.getByTestId("assistant-message").first();
    await expect(message).toBeVisible();
    const chat = page.getByTestId("agent-chat-scroll");
    const rail = page.getByTestId("interactive-response-rail");
    await expectRailSize(rail, chat);
    expect((await rail.boundingBox())!.width).toBeGreaterThan((await message.boundingBox())!.width);
    await expect(rail.getByRole("button", { name: "Project calculator", exact: true })).toHaveCount(
      0,
    );
    await rail.scrollIntoViewIfNeeded();
    await rail.screenshot({ path: info.outputPath("interactive-single-wide.png") });

    await visual.getByRole("button", { name: "Add: 3", exact: true }).click();
    await expect(visual.getByRole("button", { name: "Add: 4", exact: true })).toBeVisible();
    await expect(card.getByText("Choose 4", { exact: true })).toBeVisible();
    await expect(page.getByText("Selection received:", { exact: false })).toHaveCount(0);
    await page.getByTestId("workspace-todos-close").click();
    await expectRailSize(rail, chat);

    await page.setViewportSize({ width: 390, height: 844 });
    await expectRailSize(rail, chat);
    await rail.scrollIntoViewIfNeeded();
    await rail.screenshot({ path: info.outputPath("interactive-single-compact.png") });
    await expect(card.getByText("Choose 4", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Send to agent", exact: true }).click();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
    const timeline = await client.fetchAgentTimeline(session.agentId, { limit: 200 });
    expect(JSON.stringify(timeline)).toContain("Choose 4");
    expect(requests).toEqual([]);
  } finally {
    await client.close();
    await session.cleanup();
  }
});

async function expectRailSize(rail: Locator, chat: Locator) {
  await expect
    .poll(async () => {
      const [panel, viewport] = await Promise.all([rail.boundingBox(), chat.boundingBox()]);
      if (!panel || !viewport) return null;
      return {
        fullWidth:
          Math.abs(panel.width - viewport.width) <= 2 && Math.abs(panel.x - viewport.x) <= 2,
        height: Math.abs(panel.height - viewport.height * 0.7) <= 2,
      };
    })
    .toEqual({ fullWidth: true, height: true });
}

test("proposal titles navigate a full-width rail and preserve independent choices", async ({
  page,
}, info) => {
  const html = `<script>
let count=paseo.getState()?.count??1;
function draw(){paseo.render('<button id="add">Atlas '+count+'</button>')}
draw();paseo.on('add','click',()=>{count++;paseo.setState({count});draw()});
</script>`;
  const proposals = [
    {
      title: "Atlas · Vue express",
      summary: "Les prochaines actions par projet.",
      source: `root = Layout([Input("atlasNote","Note Atlas"), HtmlArtifact(${JSON.stringify(html)})])`,
    },
    {
      title: "Boreal · Projet prioritaire",
      summary: "Les priorités de Boreal.",
      source: 'root = Layout([Text("Projet Boreal"), Input("borealNote","Note Boreal")])',
    },
    {
      title: "Cygnus · Toutes les tâches",
      summary: "Les tâches de Cygnus.",
      source: 'root = Layout([Text("Projet Cygnus"), Input("cygnusNote","Note Cygnus")])',
    },
  ];
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-proposals-",
    title: "Proposals",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify(input)}`,
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "interactive-proposals",
  });
  try {
    await client.waitForFinish(session.agentId, 15000);
    await client.sendAgentMessage(
      session.agentId,
      `Render synthetic interactive response: ${JSON.stringify(proposals)}`,
    );
    await client.waitForFinish(session.agentId, 15000);
    await page.setViewportSize({ width: 1450, height: 1000 });
    await openAgentRoute(page, session);
    const chat = page.getByTestId("agent-chat-scroll");
    const rails = page.getByTestId("interactive-response-rail");
    const rail = rails.filter({
      has: page.getByRole("button", { name: proposals[0]!.title, exact: true }),
    });
    const atlas = rail.getByRole("button", { name: proposals[0]!.title, exact: true });
    const boreal = rail.getByRole("button", { name: proposals[1]!.title, exact: true });
    const cygnus = rail.getByRole("button", { name: proposals[2]!.title, exact: true });
    await expect(rails).toHaveCount(2);
    await expect(rails.filter({ hasText: input.title })).toHaveCount(1);
    await expect(atlas).toHaveAttribute("aria-pressed", "true");
    await expectRailSize(rail, chat);
    const note = rail.getByRole("textbox", { name: "Note Atlas" });
    const visual = rail.frameLocator('iframe[title="HTML visual"]');
    await note.fill("Garder cette note");
    await visual.getByRole("button", { name: "Atlas 1", exact: true }).click();
    await expect(visual.getByRole("button", { name: "Atlas 2", exact: true })).toBeVisible();
    await rail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("interactive-proposals-atlas.png") });

    await cygnus.click();
    await expect(cygnus).toHaveAttribute("aria-pressed", "true");
    await expect(note).toHaveCount(0);
    await rail.getByRole("textbox", { name: "Note Cygnus" }).fill("Choix Cygnus");
    await expect(rail.getByText("Projet Cygnus", { exact: true })).toBeInViewport();

    await atlas.press("Enter");
    await expect(note).toHaveValue("Garder cette note");
    await expect(visual.getByRole("button", { name: "Atlas 2", exact: true })).toBeVisible();
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-panel").filter({ visible: true })).toBeVisible();
    await expectRailSize(rail, chat);
    await boreal.click();
    await expect(boreal).toHaveAttribute("aria-pressed", "true");
    await expect(rail.getByRole("textbox", { name: "Note Boreal" })).toBeInViewport();
    await rail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("interactive-proposals-sidebar.png") });

    await page.getByTestId("workspace-todos-close").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectRailSize(rail, chat);
    await cygnus.click();
    await expect(rail.getByRole("textbox", { name: "Note Cygnus" })).toHaveValue("Choix Cygnus");
    await rail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("interactive-proposals-compact.png") });
    await expect(page.getByText("Selection received:", { exact: false })).toHaveCount(0);
    await rail.getByRole("button", { name: "Send to agent", exact: true }).click();
    await expect(rail.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
    await expect(
      page.getByText('Selection received: {"cygnusNote":"Choix Cygnus"}', { exact: true }),
    ).toBeVisible();
  } finally {
    await client.close();
    await session.cleanup();
  }
});

test("shows the update message when a host lacks interactive responses", async ({ page }) => {
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string") {
        const { type, message: event } = JSON.parse(message);
        if (
          type === "session" &&
          event?.type === "status" &&
          event.payload.status === "server_info"
        ) {
          const { interactiveResponses: _unsupported, ...features } = event.payload.features;
          socket.send(
            JSON.stringify({
              type,
              message: { ...event, payload: { ...event.payload, features } },
            }),
          );
          return;
        }
      }
      socket.send(message);
    });
  });
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-older-host-",
    title: "Interactive response on an older host",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify(input)}`,
  });
  try {
    await openAgentRoute(page, session);
    await expect(page.getByText("Update this host to use interactive responses.")).toBeVisible();
    await expect(page.getByTestId("interactive-response-rail")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Explore further", exact: true })).toHaveCount(0);
  } finally {
    await session.cleanup();
  }
});

test("a failed custom visual can be retried without losing its saved state", async ({ page }) => {
  const html =
    '<script>if(!paseo.getState()?.recovered){paseo.setState({recovered:true});while(true){}}else{paseo.render("<h2>Recovered</h2>")}</script>';
  const source = `root = Layout([HtmlArtifact(${JSON.stringify(html)})])`;
  const session = await seedMockAgentWorkspace({
    repoPrefix: "interactive-retry-",
    title: "Visual retry",
    initialPrompt: `Render synthetic interactive response: ${JSON.stringify({ title: "Visual retry", summary: "Retry the visual", source })}`,
  });
  try {
    await openAgentRoute(page, session);
    const card = page.getByTestId("interactive-response");
    await expect(card.getByRole("alert")).toBeVisible();
    await card.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(
      page
        .frameLocator('iframe[title="HTML visual"]')
        .getByRole("heading", { name: "Recovered", exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);
  } finally {
    await session.cleanup();
  }
});
