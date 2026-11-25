/* oxlint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Local task sheet actions and theme styles. */
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Button, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  sequenceAction,
  sequenceTracking,
  type SequenceRow,
  type SequenceRun,
} from "../shared/sequence.js";
import { createBatchTracking, launchBatch, type RecordObservation } from "./batch-tracking.js";
import { defaultModel, listDispatchProfiles } from "./folder-dispatch.js";

import { imageMimeType } from "./sequence-image.js";
import { SequenceAssociation, useSequenceAssociation } from "./sequence-association.js";

// oxlint-disable-next-line complexity -- Handles dispatch availability and persisted run states.
export function SequenceDispatch({
  hostId,
  task,
  project,
  navigation,
  color,
  accent,
}: {
  hostId: string;
  task: SequenceRow;
  project: SequenceRow;
  navigation: PluginScreenProps["navigation"];
  color: string;
  accent: string;
}) {
  const rpc = useRpc(sequenceTracking);
  const library = useRpc(sequenceAction);
  const cache = useQueryClient();
  const key = useMemo(() => ["projets", "sequence-run", hostId, task.id], [hostId, task.id]);
  const query = useQuery({
    queryKey: key,
    queryFn: () => rpc({ action: "read", task: task.id }),
    refetchInterval: 3000,
    retry: false,
  });
  const run = query.data;
  const tracker = useMemo(createBatchTracking, []);
  const record = useCallback<RecordObservation>(
    async (id, state, turnId) => {
      const result = await rpc({ action: "observe", task: task.id, id, state, turnId });
      if (result) cache.setQueryData(key, result);
      return result ?? undefined;
    },
    [cache, key, rpc, task.id],
  );
  useEffect(() => {
    if (run && run.state !== "failed" && run.state !== "review") {
      tracker.watch(run, record);
      return () => tracker.stop(run.id);
    }
  }, [record, run, tracker]);
  useEffect(() => () => tracker.dispose(), [tracker]);

  const [preparing, setPreparing] = useState(false);
  const [spaceId, setSpace] = useState("");
  const [profileId, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const association = useSequenceAssociation(hostId, project.id);
  const destination = association.projects.find((entry) => entry.id === association.link.data);
  const spaces = destination?.online ? destination.spaces : [];
  const space = spaces.find((entry) => entry.id === spaceId);
  const profiles = useQuery({
    queryKey: ["projets", "dispatch-profiles", hostId],
    queryFn: () => listDispatchProfiles(hostId),
    enabled: preparing && Boolean(destination?.online),
    retry: false,
  });

  const selectedProfile = profiles.data?.find((entry) => entry.id === profileId);

  function start() {
    setSpace("");
    setProfile("");
    setError("");
    setPreparing(true);
  }

  async function launch(retry?: SequenceRun) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      let attempt = retry;
      if (!attempt) {
        const profile = (await listDispatchProfiles(hostId)).find(
          (entry) => entry.id === profileId,
        );
        if (!space || !profile) throw new Error("Choisis un espace et un profil.");
        const model =
          profile.model?.trim() || (await defaultModel(hostId, space.id, profile.provider));
        const latest = await library({ action: "read" });
        if (!latest.sequence) throw new Error(latest.error ?? "Bibliothèque inaccessible.");
        if (
          latest.sequence.rows.find((row) => row.id === task.id && row.parent === project.id)
            ?.version !== task.version
        )
          throw new Error("La tâche a changé. Vérifie sa fiche.");
        const children = task.checklist.map(
          (child) => `- [${child.done ? "x" : " "}] ${child.title}`,
        );
        const prompt = [`Projet · ${project.title}`, task.title, task.notes, children.join("\n")]
          .filter(Boolean)
          .join("\n\n");
        attempt =
          (await rpc({
            action: "reserve",
            project: project.id,
            task: task.id,
            previous: run?.id,
            run: {
              id: crypto.randomUUID(),
              taskIds: [task.id],
              title: task.title,
              prompt,
              state: "launching",
              destination: {
                serverId: hostId,
                workspaceId: space.id,
                providerModel: profile.provider + "/" + model,
              },
              profile: {
                id: profile.id,
                modeId: profile.modeId ?? undefined,
                thinkingOptionId: profile.thinkingOptionId ?? undefined,
                featureValues: profile.featureValues,
              },
              images: task.images,
            },
          })) ?? undefined;
        if (!attempt) throw new Error("Envoi à confirmer.");
        cache.setQueryData(key, attempt);
      }
      const images = await Promise.all(
        attempt.images.map(async (id) => {
          const result = await library({ action: "image", id });
          if (!result.image) throw new Error(result.error ?? "Image inaccessible.");
          return { data: result.image, mimeType: imageMimeType(result.image) };
        }),
      );
      await launchBatch(attempt, record, images);
      setPreparing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Envoi à confirmer.");
      void query.refetch();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  const label =
    run &&
    {
      launching: "Envoi à confirmer",
      running: "Agent en cours",
      review: "À vérifier",
      failed: "Agent interrompu",
      unknown: "Suivi indisponible",
    }[run.state];
  const style = { color };
  return (
    <View style={styles.form}>
      {label && <Text style={style}>{label}</Text>}
      {run?.state === "launching" && (
        <Action color={accent} disabled={busy} onPress={() => void launch(run)}>
          Réessayer l’envoi
        </Action>
      )}
      {run &&
        run.state !== "launching" &&
        (run.state !== "failed" || run.turnId) &&
        navigation?.openAgent && (
          <Action
            color={accent}
            onPress={() =>
              navigation?.openAgent?.({ serverId: run.destination.serverId, agentId: run.id })
            }
          >
            Ouvrir l’agent
          </Action>
        )}
      {query.isError && (
        <Text accessibilityRole="alert" style={style}>
          Suivi indisponible.
        </Text>
      )}
      {query.isSuccess &&
        (!run || run.state === "failed") &&
        (preparing ? (
          <>
            {destination?.online ? (
              <>
                <Text style={style}>{destination.name}</Text>
                {spaces.length ? (
                  <SettingsSelect
                    label="Espace"
                    value={space?.id ?? ""}
                    onValueChange={setSpace}
                    disabled={busy}
                    options={[
                      { value: "", label: "Choisir…" },
                      ...spaces.map(({ id, name }) => ({ value: id, label: name })),
                    ]}
                  />
                ) : (
                  <Text style={style}>Aucun espace disponible.</Text>
                )}
                <SettingsSelect
                  label="Profil"
                  value={selectedProfile?.id ?? ""}
                  onValueChange={setProfile}
                  disabled={busy || !profiles.data?.length}
                  options={[
                    { value: "", label: "Choisir…" },
                    ...(profiles.data ?? []).map(({ id, name }) => ({ value: id, label: name })),
                  ]}
                />
                {profiles.isError && (
                  <Action color={accent} onPress={() => void profiles.refetch()}>
                    Recharger les profils
                  </Action>
                )}
                {profiles.isSuccess && !profiles.data.length && (
                  <Text style={style}>Aucun profil disponible.</Text>
                )}
                <Button
                  disabled={busy || !space || !selectedProfile}
                  loading={busy}
                  onPress={() => void launch()}
                >
                  Envoyer
                </Button>
              </>
            ) : (
              <>
                <SequenceAssociation association={association} color={color} />
                {destination && <Text style={style}>Projet hors ligne.</Text>}
              </>
            )}
            <Action color={accent} disabled={busy} onPress={() => setPreparing(false)}>
              Annuler
            </Action>
          </>
        ) : (
          <Action color={accent} onPress={start}>
            Confier à un agent
          </Action>
        ))}
      {error && (
        <Text accessibilityRole="alert" style={style}>
          {error}
        </Text>
      )}
    </View>
  );
}

function Action({
  color,
  children,
  onPress,
  disabled,
  selected,
}: {
  color: string;
  children: React.ReactNode;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      onPress={onPress}
      disabled={disabled}
      style={styles.action}
    >
      <Text style={{ color, opacity: disabled ? 0.45 : 1, fontWeight: selected ? "700" : "500" }}>
        {children}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8, marginTop: 12 },
  action: { paddingVertical: 5, paddingHorizontal: 2 },
});
