import { useCallback, useMemo } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAgentProfiles } from "@/agent-profiles";
import { Button } from "@/components/ui/button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { launchWorkspaceWorkflowAction } from "@/git/workflow/launch";
import { useGitActionRunner, useGitActions } from "@/git/use-actions";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

interface WorkspaceActionsProps {
  serverId: string;
  workspaceId: string;
  cwd: string;
}

export function WorkspaceActions({ serverId, workspaceId, cwd }: WorkspaceActionsProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const runGitAction = useGitActionRunner();
  const { config } = useDaemonConfig(serverId);
  const { profiles } = useAgentProfiles(serverId);
  const workflowSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceGitWorkflow === true,
  );
  const { commitAction, gitActions, workflowContext, workflowState } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });
  const workflowConfig = useMemo(
    () => config?.workspaceGitWorkflow ?? {},
    [config?.workspaceGitWorkflow],
  );
  const reviewProfile = useMemo(
    () => profiles?.find((profile) => profile.id === workflowConfig.reviewProfileId),
    [profiles, workflowConfig.reviewProfileId],
  );
  const deliveryProfile = useMemo(
    () => profiles?.find((profile) => profile.id === workflowConfig.deliveryProfileId),
    [profiles, workflowConfig.deliveryProfileId],
  );
  const openAgentsSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [router, serverId]);
  const launch = useCallback(
    (action: "review" | "create-pr" | "commit-and-push" | "repair-checks") => {
      const profile = action === "review" ? reviewProfile : deliveryProfile;
      const manual = action === "review" ? workflowConfig.reviewModel : workflowConfig.prModel;
      if (!manual && !profile) {
        openAgentsSettings();
        return;
      }
      if (!workflowContext.baseRef) return;
      if (
        action === "repair-checks" &&
        (!workflowContext.pullRequestUrl || !workflowContext.branch)
      ) {
        return;
      }
      launchWorkspaceWorkflowAction({
        action,
        serverId,
        workspaceId,
        cwd: workflowContext.cwd,
        baseRef: workflowContext.baseRef,
        branch: workflowContext.branch,
        prUrl: workflowContext.pullRequestUrl,
        profile,
        config: workflowConfig,
      });
    },
    [
      deliveryProfile,
      openAgentsSettings,
      reviewProfile,
      serverId,
      workflowConfig,
      workflowContext,
      workspaceId,
    ],
  );
  const workflowNativeAction =
    workflowState.nativeActionId === "archive-workspace"
      ? [gitActions.primary, ...gitActions.secondary].find(
          (action) => action?.id === "archive-workspace",
        )
      : [gitActions.primary, ...gitActions.secondary].find(
          (action) => action?.id === workflowState.nativeActionId,
        );
  const viewPrAction = useMemo(
    () =>
      [gitActions.primary, ...gitActions.secondary].find((action) => action?.id === "pr") ?? null,
    [gitActions.primary, gitActions.secondary],
  );
  const workflowDisabled =
    !workflowSupported ||
    workflowState.action === "checking" ||
    workflowState.action === "unavailable" ||
    (workflowNativeAction?.disabled ?? false);

  const workflowLabel = useMemo(() => {
    switch (workflowState.action) {
      case "create-pr":
        return t("workspace.git.actions.createPr.label");
      case "commit-and-push":
        return t("workspace.git.workflow.commitAndPush");
      case "repair-checks":
        return t("workspace.git.workflow.repairChecks");
      case "merge":
        return t("workspace.git.workflow.merge");
      case "view-pr":
        return t("workspace.git.actions.viewPr");
      case "archive":
        return t("workspace.git.actions.archive.label");
      case "checking":
        return t("workspace.git.workflow.checking");
      case "unavailable":
        return t("workspace.git.workflow.unavailable");
    }
  }, [t, workflowState.action]);

  const handleReview = useCallback(() => launch("review"), [launch]);
  const handleCommit = useCallback(() => runGitAction(commitAction), [runGitAction, commitAction]);
  const handlePr = useCallback(() => {
    const action = workflowState.action;
    if (action === "create-pr" || action === "commit-and-push" || action === "repair-checks") {
      launch(action);
      return;
    }
    if (workflowNativeAction) runGitAction(workflowNativeAction);
  }, [launch, workflowState.action, workflowNativeAction, runGitAction]);
  const handleViewPr = useCallback(() => {
    if (viewPrAction) runGitAction(viewPrAction);
  }, [runGitAction, viewPrAction]);

  return (
    <>
      <Button
        size="xs"
        variant="secondary"
        testID="workspace-git-review"
        disabled={!workflowSupported}
        onPress={handleReview}
      >
        Review
      </Button>
      <Button
        size="xs"
        variant="secondary"
        testID="workspace-git-commit"
        disabled={commitAction.disabled}
        loading={commitAction.status === "pending"}
        onPress={handleCommit}
      >
        Commit
      </Button>
      {workflowState.action === "repair-checks" ? (
        <Button
          size="xs"
          variant="secondary"
          testID="workspace-git-view-pr"
          disabled={!viewPrAction || viewPrAction.disabled}
          loading={viewPrAction?.status === "pending"}
          onPress={handleViewPr}
        >
          {t("workspace.git.actions.viewPr")}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="default"
        testID="changes-primary-cta"
        disabled={workflowDisabled}
        loading={workflowNativeAction?.status === "pending"}
        onPress={handlePr}
      >
        {workflowLabel}
      </Button>
    </>
  );
}
