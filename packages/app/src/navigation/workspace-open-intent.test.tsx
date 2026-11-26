// @vitest-environment jsdom
import React, { createContext, useContext } from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import WorkspaceRoute from "@/app/h/[serverId]/workspace/[workspaceId]/index";
import { encodeWorkspaceIdForPathSegment } from "@/utils/host-routes";

const prepare = vi.hoisted(() => vi.fn());
const Route = createContext({
  workspaceId: "",
  focused: false,
  open: "",
  ready: false,
  clear: vi.fn(),
});
vi.mock("expo-router", () => ({
  useLocalSearchParams() {
    const route = useContext(Route);
    return {
      serverId: "host",
      workspaceId: encodeWorkspaceIdForPathSegment(route.workspaceId),
      open: route.open,
    };
  },
  useRootNavigationState: () => ({ key: "root" }),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => useContext(Route).focused,
  useNavigation() {
    const route = useContext(Route);
    return { isFocused: () => route.focused, setParams: route.clear };
  },
}));
vi.mock("@/components/host-route-bootstrap-boundary", () => ({
  HostRouteBootstrapBoundary: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => null,
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useHasHydratedWorkspaces: () => useContext(Route).ready,
  useWorkspaceExists: () => true,
}));
vi.mock("@/screens/workspace/workspace-screen", () => ({ WorkspaceScreen: () => null }));
vi.mock("@/stores/workspace-layout-store", () => ({ useWorkspaceLayoutStoreHydrated: () => true }));
vi.mock("@/utils/workspace-navigation", () => ({ prepareWorkspaceTab: prepare }));

it("only the focused destination consumes a delayed open while both workspace routes stay mounted", () => {
  vi.stubGlobal("React", React);
  const spaces = ["things", "as-store"];
  const clear = [vi.fn(), vi.fn()];
  const screens = (focused: number, ready: boolean) => {
    const routes = spaces.map((workspaceId, i) => ({
      workspaceId,
      focused: focused === i,
      ready,
      open: "agent:" + workspaceId,
      clear: clear[i],
    }));
    return routes.map((route) => (
      <Route.Provider key={route.workspaceId} value={route}>
        <WorkspaceRoute />
      </Route.Provider>
    ));
  };
  const view = render(screens(0, false));
  view.rerender(screens(1, false));
  expect(prepare).not.toHaveBeenCalled();
  view.rerender(screens(1, true));
  expect(clear[0]).not.toHaveBeenCalled();
  expect(clear[1]).toHaveBeenCalledWith({ open: undefined });
  view.rerender(screens(0, true));
  expect(
    prepare.mock.calls.map(([request]) => [request.workspaceId, request.target.agentId]),
  ).toEqual([
    ["as-store", "as-store"],
    ["things", "things"],
  ]);
  view.unmount();
  vi.unstubAllGlobals();
});
