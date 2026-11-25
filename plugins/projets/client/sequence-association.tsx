/* oxlint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Local project picker. */
import { useProjects, useRpc } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { sequenceAssociation } from "../shared/sequence.js";

export function useSequenceAssociation(hostId: string, project: string) {
  const rpc = useRpc(sequenceAssociation);
  const cache = useQueryClient();
  const key = ["projets", "association", hostId, project];
  const link = useQuery({
    queryKey: key,
    queryFn: () => rpc({ action: "read", project }),
    refetchInterval: 3000,
  });
  const update = useMutation({
    mutationFn: (destination: string | null) => rpc({ action: "write", project, destination }),
    onSuccess: async (destination) => {
      await cache.cancelQueries({ queryKey: key });
      cache.setQueryData(key, destination);
    },
  });
  const directory = useProjects();
  const projects = directory.projects.flatMap(({ projectName, hosts }) =>
    hosts
      .filter((host) => host.serverId === hostId)
      .map((host) => ({
        id: host.projectId,
        name: projectName,
        online: host.isOnline,
        spaces: host.workspaces.filter((space) => !space.archivingAt),
      })),
  );
  return { link, update, projects, loading: directory.isLoading };
}

export function SequenceAssociation({
  association,
  color,
}: {
  association: ReturnType<typeof useSequenceAssociation>;
  color: string;
}) {
  const { link, loading, projects, update } = association;
  const value = link.data ?? "";
  const missing = value && !projects.some((project) => project.id === value);
  const options = [
    { value: "", label: value ? "Dissocier" : "Associer…" },
    ...projects.map(({ id, name }) => ({ value: id, label: name })),
  ];
  if (missing) options.push({ value, label: "Projet indisponible" });
  const textStyle = { color };
  return (
    <View>
      <SettingsSelect
        label="Projet Paseo"
        value={value}
        options={options}
        disabled={link.isPending || link.isError || loading || update.isPending}
        onValueChange={(id) => update.mutate(id || null)}
      />
      {(link.isError || update.isError) && (
        <Text accessibilityRole="alert" style={textStyle}>
          Association indisponible.
        </Text>
      )}
    </View>
  );
}

export function SequenceProjectAssociation({
  hostId,
  project,
  color,
}: {
  hostId: string;
  project: string;
  color: string;
}) {
  const association = useSequenceAssociation(hostId, project);
  return <SequenceAssociation association={association} color={color} />;
}
