import {
  useProjects,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { createProjectsScreen } from "./client/projects-screen.js";
import { createBatchTracking } from "./client/batch-tracking.js";

import { ListPrototype, readVariant } from "./client/list-prototype.js";

const previewLink = {
  padding: "8px 16px",
  background: "#f4f2e9",
  color: "#476346",
  font: "14px system-ui",
};

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
    Component: function ProjectsWithPrototype(props: PluginScreenProps) {
      if (props.layout.platform !== "web" || !props.isFocused) return <ProjectsScreen {...props} />;
      const variant = readVariant(props.params.variant);
      if (variant) return <ListPrototype key={variant} initial={variant} />;
      return (
        <>
          <a href="?param.variant=phases" style={previewLink}>
            Essayer les listes
          </a>
          <ProjectsScreen {...props} />
        </>
      );
    },
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
