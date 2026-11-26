import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQueries } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export function useForeignPinnedAgentIds(input: {
  serverId: string;
  workspaceId: string;
  pinnedAgentIds: ReadonlySet<string>;
  client: DaemonClient | null;
}): ReadonlySet<string> {
  const { serverId, workspaceId, pinnedAgentIds, client } = input;
  const ids = useMemo(() => Array.from(pinnedAgentIds), [pinnedAgentIds]);
  const owners = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return ids.map((id) =>
        normalizeWorkspaceOpaqueId(
          session?.agents.get(id)?.workspaceId ?? session?.agentDetails.get(id)?.workspaceId,
        ),
      );
    }),
  );

  // Archived agents may only exist in history. Absence from the active directory
  // cannot distinguish a foreign pin from an intentionally opened history tab.
  const unknownIds = ids.filter((_, index) => !owners[index]);
  const foreignIds = useFetchQueries<string | null, string[]>(
    client
      ? unknownIds.map((agentId) => ({
          queryKey: ["pinnedAgentWorkspace", serverId, agentId],
          queryFn: async () =>
            normalizeWorkspaceOpaqueId((await client.fetchAgent({ agentId }))?.agent.workspaceId),
          dataShape: "value",
          staleTimeMs: 0,
        }))
      : [],
    (results) =>
      client
        ? [
            ...ids.filter((_, index) => owners[index] && owners[index] !== workspaceId),
            ...unknownIds.filter(
              (_, index) => results[index]?.data && results[index].data !== workspaceId,
            ),
          ]
        : [],
  );
  return useMemo(() => new Set(foreignIds), [foreignIds]);
}
