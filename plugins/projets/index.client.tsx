import {
  useProjects,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Text } from "react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { TaskCapture } from "./client/task-capture.js";
import { CaptureSettings } from "./client/capture-settings.js";
import { useCallback, useMemo, useState } from "react";
import { createProjectsScreen } from "./client/projects-screen.js";
import { createBatchTracking } from "./client/batch-tracking.js";

import { ThingsConnection } from "./client/things-connection.js";
import { createFolderStore } from "./client/folder-store.js";
import { ProjectsBoard, initialBoard } from "./client/priority-prototype.js";
import { BoardWindow, BoardWindowButton } from "./client/board-window.js";

const rowStyle = `
.projectRowActions { display:flex; align-items:center; }
.projectRowActions button { display:grid; place-items:center; }
.projectsCaptureRow .projectRowActions button { opacity:0; padding:0; width:26px; height:26px; border:0; border-radius:5px; background:transparent; color:inherit; font:18px system-ui; cursor:pointer }
.projectsCaptureRow:hover .projectRowActions button,.projectsCaptureRow:focus-within .projectRowActions button { opacity:1 }
.projectsCaptureRow .projectRowActions button:hover { background:#8882 }
@media (hover:none),(pointer:coarse){.projectsCaptureRow .projectRowActions button{opacity:1}}
`;
const rocketStyle = { fontSize: 16, lineHeight: 20 } as const;
function ProjectsIcon() {
  return (
    <Text accessible={false} style={rocketStyle}>
      🚀
    </Text>
  );
}

function ProjectsRow({ currentScreen, openScreen, host, layout }: PluginSidebarItemProps) {
  const active = currentScreen?.screenId === "main";
  const store = useMemo(() => createFolderStore(host.id, initialBoard), [host.id]);
  const web = layout.platform === "web";
  const [show, setShow] = useState(false);
  const openCapture = useCallback(() => setShow(true), []);
  const closeCapture = useCallback(() => setShow(false), []);
  const open = useCallback(() => {
    if (!active) openScreen({ screenId: "main" });
  }, [active, openScreen]);
  const actions = useMemo(
    () => (
      <div className="projectRowActions">
        <button
          type="button"
          className="projectsCaptureAdd"
          aria-label="Ajouter des tâches"
          title="Ajouter des tâches"
          onClick={openCapture}
        >
          +
        </button>
        <BoardWindowButton hostId={host.id} />
      </div>
    ),
    [openCapture, host.id],
  );
  if (!web) return <SidebarRow icon={ProjectsIcon} active={active} onPress={open} />;

  return (
    <div className="projectsCaptureRow">
      <style>{rowStyle}</style>
      {!active && <ThingsConnection store={store} hostId={host.id} silent />}
      <SidebarRow icon={ProjectsIcon} active={active} onPress={open} trailing={actions} />
      {show && <TaskCapture key={host.id} hostId={host.id} close={closeCapture} />}
    </div>
  );
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
    Component: function ProjectSurface(props: PluginScreenProps) {
      if (!props.isFocused) return null;
      if (props.layout.platform !== "web") return <ProjectsScreen {...props} />;
      const board = (
        <ProjectsBoard
          hostId={props.host.id}
          navigation={props.navigation}
          colors={props.theme.colors}
        />
      );
      return props.params.fenetre === "projets" ? <BoardWindow>{board}</BoardWindow> : board;
    },
  });
  const removeCapture = client.addScreen({
    id: "desktop-capture",
    title: "Ajouter des tâches",
    Component: function DesktopTaskCapture({ host, desktopCapture }: PluginScreenProps) {
      if (!desktopCapture) return null;
      return <TaskCapture hostId={host.id} close={desktopCapture.close} capture={desktopCapture} />;
    },
  });
  const removeSettings = client.addSettingsScreen({
    id: "capture",
    title: "Projets",
    icon: "PanelsTopLeft",
    Component: CaptureSettings,
  });
  const removeRow = client.addSidebarFooterItem({
    id: "main",
    title: "Projets",
    placement: "before-opendesign",
    Component: ProjectsRow,
  });
  return () => {
    removeCapture();
    removeSettings();
    removeRow();
    removeScreen();
    tracking.dispose();
  };
}
