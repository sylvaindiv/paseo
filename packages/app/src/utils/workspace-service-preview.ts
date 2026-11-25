import { parseServicePreviewUrl } from "@getpaseo/protocol/service-preview";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import type { ServicePreviewTarget } from "@/desktop/browser/store/state";

export async function resolveWorkspaceServicePreview(
  url: string,
  workspace: Pick<ServicePreviewTarget, "serverId" | "workspaceId">,
): Promise<ServicePreviewTarget | undefined> {
  const service = parseServicePreviewUrl(url);
  if (!service) return undefined;
  const status = await getDesktopDaemonStatus().catch(() => null);
  if (status?.serverId === workspace.serverId) return undefined;
  return { ...workspace, origin: service.origin };
}

export function hasSameServicePreview(
  first: ServicePreviewTarget | undefined,
  second: ServicePreviewTarget | undefined,
): boolean {
  return (
    first?.origin === second?.origin &&
    first?.serverId === second?.serverId &&
    first?.workspaceId === second?.workspaceId
  );
}
