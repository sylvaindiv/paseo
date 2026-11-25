import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { sequenceAction, sequenceActivity } from "../shared/sequence.js";

export function useSequence(hostId: string) {
  const rpc = useRpc(sequenceAction);
  const query = useQuery({
    queryKey: ["projets", "sequence", hostId],
    queryFn: async () => {
      const result = await rpc({ action: "read" });
      if (!result.sequence) throw new Error(result.error ?? "Bibliothèque inaccessible.");
      return result.sequence;
    },
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    retry: false,
  });
  return { query, rpc };
}

export function useSequenceActivity(hostId: string) {
  const rpc = useRpc(sequenceActivity);
  return useQuery({
    queryKey: ["projets", "sequence-activity", hostId],
    queryFn: () => rpc({}),
    select: (agents) =>
      new Map(agents.map(({ task, agentId, serverId }) => [task, { agentId, serverId }])),
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    retry: false,
  });
}
