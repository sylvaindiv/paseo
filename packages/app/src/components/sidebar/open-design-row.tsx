import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useToast } from "@/contexts/toast-context";
import { getBrowserRecord } from "@/desktop/browser/store";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import {
  collectAllPanes,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openWorkspaceBrowser } from "@/workspace-tabs/browser";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const OPENDESIGN_URL = "http://127.0.0.1:51144/";
const OPENDESIGN_INTENT = "opendesign";

function OpenDesignIcon({ size }: { size: number }) {
  const style = useMemo(
    () => ({ width: size, fontSize: size, lineHeight: size, textAlign: "center" as const }),
    [size],
  );
  return (
    <Text aria-hidden style={style}>
      🎨
    </Text>
  );
}

export function OpenDesignRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useLocalDaemonServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const selection = useActiveWorkspaceSelection();
  const opening = useRef(false);
  const workspace = useSessionStore((state) =>
    state.sessions[serverId]?.workspaces
      .values()
      .find((entry) => entry.intent === OPENDESIGN_INTENT && !entry.archivingAt),
  );

  const open = useCallback(async () => {
    if (opening.current) return;
    if (!client || !serverId) {
      toast.error(t("workspaceSetup.errors.hostDisconnected"));
      return;
    }

    opening.current = true;
    try {
      let destination = workspace;
      if (!destination) {
        const result = await client.createWorkspace({
          title: "OpenDesign",
          intent: OPENDESIGN_INTENT,
          source: { kind: "directory", path: "~/Applis/Perso/opendesign" },
        });
        if (!result.workspace || result.error) {
          throw new Error(result.error ?? "Missing workspace");
        }
        destination = normalizeWorkspaceDescriptor(result.workspace);
        getHostRuntimeStore().acceptWorkspaceSnapshots(serverId, [destination]);
      }

      const workspaceId = destination.id;
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (!workspaceKey) throw new Error("Missing workspace identity");
      const store = useWorkspaceLayoutStore.getState();
      const layout = store.layoutByWorkspace[workspaceKey];
      const existing =
        layout &&
        collectAllTabs(layout.root).find((tab) => {
          if (tab.target.kind !== "browser") return false;
          return getBrowserRecord(tab.target.browserId)?.url.startsWith(OPENDESIGN_URL);
        });
      const result = openWorkspaceBrowser({
        workspaceKey,
        url: OPENDESIGN_URL,
        browserId: existing?.target.kind === "browser" ? existing.target.browserId : undefined,
        intent: "reveal",
      });
      if (!result.ok) throw new Error(result.code);

      // Revealing the browser creates a companion launcher even in a new workspace.
      for (const pane of collectAllPanes(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
      )) {
        const tabs = collectAllTabs({ kind: "pane", pane });
        if (tabs.length === 1 && tabs[0]?.target.kind === "new_tab") {
          store.closePane(workspaceKey, pane.id);
        }
      }

      onBeforeNavigate?.();
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "browser", browserId: result.browserId },
      });
    } catch {
      toast.error(t("workspaceSetup.errors.failedOpenProject"));
    } finally {
      opening.current = false;
    }
  }, [client, onBeforeNavigate, serverId, t, toast, workspace]);

  return (
    <SidebarHeaderRow
      icon={OpenDesignIcon}
      label="OpenDesign"
      variant="inline"
      testID="sidebar-opendesign"
      isActive={
        !!workspace && selection?.serverId === serverId && selection.workspaceId === workspace.id
      }
      onPress={open}
    />
  );
}
