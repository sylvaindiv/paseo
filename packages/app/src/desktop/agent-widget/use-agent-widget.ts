import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  WidgetActionDeliverySchema,
  type WidgetSnapshot,
} from "@getpaseo/protocol/desktop-agent-widget";
import { getDesktopHost } from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { respondToWidgetRequest, projectWidgetRequest } from "./model";
import { useAgentProfiles } from "@/agent-profiles";
import { pluginRegistry } from "@/plugins/registry";
import { handoffReason, handoffWidgetPlan } from "./handoff";

export function useAgentWidget(serverId: string): void {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(serverId);
  useEffect(() => {
    const bridge = getDesktopHost()?.agentWidget;
    if (!bridge) return;
    const runtime = getHostRuntimeStore();
    const labels = {
      plan: t("desktop.agentWidget.planReady"),
      question: t("desktop.agentWidget.responseNeeded"),
      execute: t("desktop.agentWidget.execute"),
      comment: t("desktop.agentWidget.comment"),
      sendComment: t("desktop.agentWidget.sendComment"),
      handoff: t("desktop.agentWidget.handoff"),
      noProfiles: t("workspace.git.workflow.noProfiles"),
      submit: t("message.question.submit"),
      next: t("message.question.next"),
      close: t("common.actions.close"),
      minimize: t("desktop.windowControls.minimize"),
      pending: t("common.states.loading"),
      sent: t("desktop.agentWidget.responseSent"),
      offline: t("common.errors.daemonClientDisconnected"),
      failed: t("common.errors.error"),
    };
    const publish = () => {
      const session = useSessionStore.getState().sessions[serverId];
      const host = runtime.getSnapshot(serverId);
      const requests: WidgetSnapshot["requests"] = [];
      for (const pending of session?.pendingPermissions.values() ?? []) {
        const agent = session?.agents.get(pending.agentId);
        if (!agent || agent.archivedAt) continue;
        const workspace = agent.workspaceId
          ? session?.workspaces.get(agent.workspaceId)
          : undefined;
        const item = projectWidgetRequest({
          serverId,
          agentId: pending.agentId,
          request: pending.request,
          agentTitle: agent.title ?? agent.provider,
          workspace: workspace ? `${workspace.projectDisplayName} · ${workspace.name}` : agent.cwd,
          workspaceId: agent.workspaceId ?? undefined,
          handoffProfiles: profiles?.map(({ id, name }) => ({ id, name })),
          handoffDisabledReason: handoffReason(
            serverId,
            agent.workspaceId ?? undefined,
            pending.request.sourcePlanCallId,
          ),
        });
        if (item) requests.push(item);
      }
      const online = host?.connectionStatus === "online" && host.agentDirectoryStatus === "ready";
      void bridge
        .publish({ serverId, online, requests, labels })
        .catch((error) => console.warn("[agent-widget] Failed to publish requests", error));
    };
    const offActions = bridge.onAction(async (raw) => {
      const parsed = WidgetActionDeliverySchema.safeParse(raw);
      if (!parsed.success || parsed.data.serverId !== serverId) return;
      const { action, operationId } = parsed.data;
      let error: string | null = null;
      try {
        const host = runtime.getSnapshot(serverId);
        if (
          !host?.client ||
          host.connectionStatus !== "online" ||
          host.agentDirectoryStatus !== "ready"
        )
          throw new Error(labels.offline);
        const session = useSessionStore.getState().sessions[serverId];
        const pending = [...(session?.pendingPermissions.values() ?? [])].find(
          (item) => JSON.stringify([serverId, item.agentId, item.request.id]) === action.key,
        );
        if (!pending) throw new Error("This request has already been resolved.");
        if (action.type === "handoff") {
          await handoffWidgetPlan({
            client: host.client,
            bridge,
            serverId,
            agentId: pending.agentId,
            workspaceId: session?.agents.get(pending.agentId)?.workspaceId ?? undefined,
            request: pending.request,
            operationId,
            action,
          });
        } else {
          await respondToWidgetRequest({
            client: host.client,
            agentId: pending.agentId,
            request: pending.request,
            operationId,
            action,
          });
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      await bridge
        .result({ operationId, error })
        .catch((cause) => console.warn("[agent-widget] Failed to acknowledge response", cause));
    });
    const offSession = useSessionStore.subscribe(
      (state) => state.sessions[serverId]?.pendingPermissions,
      publish,
    );
    const offRuntime = runtime.subscribe(serverId, publish);
    const offPlugins = pluginRegistry.subscribe(publish);
    const release = runtime.acquireDirectoryDemand(serverId);
    publish();
    return () => {
      offActions();
      offSession();
      offRuntime();
      offPlugins();
      release();
      void bridge
        .publish({ serverId, online: false, requests: [], labels })
        .catch((error) => console.warn("[agent-widget] Failed to release requests", error));
    };
  }, [serverId, t, profiles]);
}
