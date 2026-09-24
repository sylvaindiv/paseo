import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchWorkspaceWorkflowAction } from "./launch";

const calls = vi.hoisted(() => ({ pending: vi.fn(), submitting: vi.fn(), navigate: vi.fn() }));
vi.mock("@/stores/create-flow-store", () => ({
  useCreateFlowStore: { getState: () => ({ setPending: calls.pending }) },
}));
vi.mock("@/stores/workspace-draft-submission-store", () => ({
  useWorkspaceDraftSubmissionStore: { getState: () => ({ setPending: calls.submitting }) },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: calls.navigate,
}));
vi.mock("@/stores/draft-keys", () => ({ generateDraftId: () => "draft" }));
vi.mock("@/agent-profiles", async () => import("@/agent-profiles/internal/materialize-profile"));

const context = {
  serverId: "host",
  workspaceId: "workspace",
  cwd: "/repo",
  baseRef: "origin/paseo-local",
  branch: "feature",
};
const profile = {
  id: "legacy",
  name: "Legacy",
  provider: "claude",
  model: "legacy-model",
  modeId: "plan",
  thinkingOptionId: "high",
  featureValues: { plan_mode: true },
};

describe("workspace workflow launch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the manual review choice without a profile or JEV routing", () => {
    launchWorkspaceWorkflowAction({
      ...context,
      action: "review",
      config: { reviewModel: { provider: "codex", model: "review", thinkingOptionId: "low" } },
    });
    expect(calls.submitting.mock.calls[0][0]).toMatchObject({
      provider: "codex",
      model: "review",
      thinkingOptionId: "low",
      featureValues: {},
    });
    expect(calls.submitting.mock.calls[0][0]).not.toHaveProperty("launchProfileId");
    expect(calls.submitting.mock.calls[0][0]).not.toHaveProperty("modelRouting");
    expect(calls.navigate.mock.calls[0][0].target.setup).toMatchObject({
      provider: "codex",
      model: "review",
      thinkingOptionId: "low",
    });
    expect(calls.submitting.mock.calls[0][0].text).toContain("origin/paseo-local");
    expect(calls.submitting.mock.calls[0][0].text).not.toContain("origin/main");
  });

  it.each(["create-pr", "commit-and-push"] as const)(
    "uses PR choice for %s without inheriting profile mode",
    (action) => {
      launchWorkspaceWorkflowAction({
        ...context,
        action,
        profile,
        config: {
          prModel: { provider: "codex", model: "pr" },
          reviewModel: { provider: "claude", model: "review" },
        },
      });
      const request = calls.submitting.mock.calls[0][0];
      expect(request).toMatchObject({ provider: "codex", model: "pr", featureValues: {} });
      expect(request).not.toHaveProperty("modeId");
      expect(request).not.toHaveProperty("thinkingOptionId");
      expect(request).not.toHaveProperty("launchProfileId");
    },
  );

  it("preserves the existing profile when no manual choice is configured", () => {
    launchWorkspaceWorkflowAction({
      ...context,
      action: "review",
      profile,
      config: { reviewModel: null },
    });
    expect(calls.submitting.mock.calls[0][0]).toMatchObject({
      provider: "claude",
      model: "legacy-model",
      modeId: "plan",
      thinkingOptionId: "high",
      launchProfileId: "legacy",
      featureValues: { plan_mode: true },
    });
  });

  it("launches local check repair with the PR model and a local-only prompt", () => {
    launchWorkspaceWorkflowAction({
      ...context,
      action: "repair-checks",
      prUrl: "https://example.com/pr/8",
      config: {
        prModel: { provider: "codex", model: "pr" },
        reviewModel: { provider: "claude", model: "review" },
        commitAndPushPrompt: "COMMIT_PUSH_SENTINEL",
      },
    });
    const request = calls.submitting.mock.calls[0][0];
    expect(request).toMatchObject({ provider: "codex", model: "pr", featureValues: {} });
    expect(request).not.toHaveProperty("modeId");
    expect(request).not.toHaveProperty("thinkingOptionId");
    expect(request).not.toHaveProperty("launchProfileId");
    const prompt = request.text as string;
    expect(prompt).toContain("https://example.com/pr/8");
    expect(prompt).toContain("feature");
    expect(prompt).toContain("origin/paseo-local");
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("aucun commit, push, merge");
    expect(prompt).not.toContain("COMMIT_PUSH_SENTINEL");
  });

  it("refuses to launch check repair without a pull request or branch", () => {
    expect(() =>
      launchWorkspaceWorkflowAction({
        ...context,
        action: "repair-checks",
        prUrl: null,
        config: { prModel: { provider: "codex", model: "pr" } },
      }),
    ).toThrow();
    expect(() =>
      launchWorkspaceWorkflowAction({
        ...context,
        action: "repair-checks",
        branch: null,
        prUrl: "https://example.com/pr/8",
        config: { prModel: { provider: "codex", model: "pr" } },
      }),
    ).toThrow();
  });
});
