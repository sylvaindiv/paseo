import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { handoffReason, handoffWidgetPlan } from "./handoff";

const { plugins, run, navigate } = vi.hoisted(() => ({
  plugins: vi.fn(),
  run: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/plugins/registry", () => ({ pluginRegistry: { getSnapshot: plugins } }));
vi.mock("@/plugins/plan-actions/contribution", () => ({ runPlanContribution: run }));
vi.mock("@/plugins/navigation", () => ({ createPluginNavigation: () => ({ openAgent() {} }) }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: navigate }));

const request: AgentPermissionRequest = {
  id: "permission",
  provider: "codex",
  name: "Plan",
  kind: "plan",
  sourcePlanCallId: "call-1",
  metadata: { planText: "# Exact plan\n\nSecond line." },
};
const action = {
  type: "handoff" as const,
  profileId: "profile-1",
  key: "request-key",
  planCallId: "call-1",
  planText: "# Exact plan\n\nSecond line.",
};
const progress = vi.fn().mockResolvedValue(undefined);
const input = {
  client: {} as Parameters<typeof handoffWidgetPlan>[0]["client"],
  bridge: { progress } as unknown as Parameters<typeof handoffWidgetPlan>[0]["bridge"],
  serverId: "host",
  agentId: "planner",
  workspaceId: "workspace",
  request,
  operationId: "operation",
  action,
};
const plugin = {
  serverId: "host",
  id: "paseo-workflow",
  lifetime: new AbortController(),
  planActions: [{ id: "handoff", title: "Handoff" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  plugins.mockReturnValue([plugin]);
  run.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("widget handoff", () => {
  it("shows a reason when the contribution is absent or disabled", () => {
    plugins.mockReturnValue([]);
    expect(handoffReason("host", "workspace", "call-1")).toContain("Install paseo-workflow");
    plugins.mockReturnValue([
      { ...plugin, planActions: [{ id: "handoff", disabledReason: "Unavailable" }] },
    ]);
    expect(handoffReason("host", "workspace", "call-1")).toBe("Unavailable");
  });

  it("rejects a replaced plan before invoking the plugin", async () => {
    await expect(
      handoffWidgetPlan({ ...input, action: { ...action, planText: "Older plan" } }),
    ).rejects.toThrow("replaced");
    expect(run).not.toHaveBeenCalled();
  });

  it("requires an explicit profile before invoking the plugin", async () => {
    await expect(
      handoffWidgetPlan({ ...input, action: { ...action, profileId: undefined } }),
    ).rejects.toThrow("Choose an agent profile");
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the exact plan and selects the executor without a window focus call", async () => {
    run.mockImplementation(async ({ navigation }) => navigation.openAgent("executor"));
    await handoffWidgetPlan(input);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        contributionId: "handoff",
        profileId: "profile-1",
        workspaceId: "workspace",
        agentId: "planner",
        plan: { callId: "call-1", text: action.planText, permissionRequestId: "permission" },
      }),
    );
    expect(navigate).toHaveBeenCalledWith({
      serverId: "host",
      agentId: "executor",
      workspaceId: "workspace",
    });
  });

  it("renews progress beyond thirty seconds, stops signaling, and allows a failed retry", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = handoffWidgetPlan(input);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(progress).toHaveBeenCalledTimes(3);
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress).toHaveBeenCalledTimes(3);
    run.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(handoffWidgetPlan(input)).rejects.toThrow("Disconnected");
    await expect(handoffWidgetPlan(input)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
