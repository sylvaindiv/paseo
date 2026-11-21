import type { PluginWorkspaceTodosViewProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { PluginInstallationProvider } from "./installation-provider";
import { resolvePluginPlatform } from "./platform";
import { useInstalledPlugins } from "./registry";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { toPluginTheme } from "./theme";

function WorkspaceTodosView({
  serverId,
  children,
  theme,
  ...props
}: Omit<PluginWorkspaceTodosViewProps, "host" | "layout"> & {
  serverId: string;
  children: ReactNode;
}) {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [serverId, hostLabel]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const showFallback = useCallback(() => children, [children]);
  const installation = plugins.find(
    (plugin) => plugin.serverId === serverId && plugin.workspaceTodosViews.length > 0,
  );
  const Component = installation?.workspaceTodosViews[0]?.Component;
  if (!installation || !Component) return children;

  return (
    <SurfaceErrorBoundary
      installation={installation}
      Surface={Component}
      renderError={showFallback}
    >
      <PluginInstallationProvider plugin={installation}>
        <Component {...props} theme={theme} host={host} layout={layout} />
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

export const PluginWorkspaceTodosView = withUnistyles(WorkspaceTodosView, (theme: Theme) => ({
  theme: toPluginTheme(theme),
}));
