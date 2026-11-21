import {
  useProjects,
  type PluginClientContext,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { createProjectsScreen } from "./client/projects-screen.js";
import { createBatchTracking } from "./client/batch-tracking.js";

function ProjectsRow({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const active = currentScreen?.screenId === "main";
  const open = useCallback(() => {
    if (!active) openScreen({ screenId: "main" });
  }, [active, openScreen]);
  return <SidebarRow icon="PanelsTopLeft" active={active} onPress={open} />;
}

export default function contribute(client: PluginClientContext) {
  if (typeof useProjects !== "function" || !client.localStorage) {
    throw new Error("Mettez à jour Paseo pour utiliser Projets.");
  }
  const tracking = createBatchTracking();
  const ProjectsScreen = createProjectsScreen(client.localStorage, tracking);
  const removeScreen = client.addScreen({
    id: "main",
    title: "Projets",
    Component: ProjectsScreen,
  });
  const removeRow = client.addSidebarFooterItem({
    id: "main",
    title: "Projets",
    placement: "before-opendesign",
    Component: ProjectsRow,
  });
  return () => {
    removeRow();
    removeScreen();
    tracking.dispose();
  };
}
