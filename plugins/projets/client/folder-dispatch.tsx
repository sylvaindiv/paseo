/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Local actions on the task sheet. */
import {
  getPaseoClient,
  useProjects,
  type PluginScreenProps,
  type PluginProjectSummary,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectBatch } from "../shared/project-todos.js";
import {
  createBatchTracking,
  launchBatch,
  type RecordObservation,
  type ProfileSettings,
} from "./batch-tracking.js";
import type { FolderStore } from "./folder-store.js";
import type { Task } from "./priority-prototype.js";

export interface FolderRun extends ProjectBatch {
  files: File[];
  profile?: ProfileSettings;
}

export function running(run?: FolderRun) {
  return !!run && run.state !== "review" && run.state !== "failed";
}

function brief(project: string, task: Task) {
  const lines = [`Projet · ${project}`, "", task.title.trim()];
  if (task.note?.trim()) lines.push("", task.note.trim());
  const children = task.children.filter((c) => c.title.trim());
  if (children.length)
    lines.push("", "Sous-tâches", ...children.map((c) => `- [${c.done ? "x" : " "}] ${c.title}`));
  return lines.join("\n");
}

export function encodeImage(file: File) {
  return new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve({ data: String(reader.result).split(",")[1]!, mimeType: file.type }),
    );
    reader.addEventListener("error", () => reject(new Error("Image illisible : " + file.name)));
    reader.readAsDataURL(file);
  });
}

export function useFolderTracking(items: Task[], store: FolderStore) {
  const tracking = useMemo(createBatchTracking, [store]);
  const record = useCallback<RecordObservation>(
    async (id, state, turnId) => {
      const board = await store.write((current) => {
        const task = current.items.find((t) => t.run?.id === id);
        const run = task?.run;
        if (!task || !run || !running(run) || (run.turnId && run.turnId !== turnId)) return current;
        if (run.state === "launching" && state === "unknown") return current;
        const status = { review: 2, failed: 0, running: 1, unknown: 1 }[state];
        return {
          ...current,
          items: current.items.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status,
                  run: { ...run, state, turnId: turnId ?? run.turnId, files: [] },
                }
              : t,
          ),
        };
      });
      return board.items.find((t) => t.run?.id === id)?.run;
    },
    [store],
  );
  useEffect(() => {
    for (const { run } of items) {
      if (run && running(run)) tracking.watch(run, record);
      else if (run) tracking.stop(run.id);
    }
  }, [items, tracking, record]);
  useEffect(() => () => tracking.dispose(), [tracking]);
  return record;
}

interface Props {
  hostId: string;
  project: string;
  projectKey: string;
  task: Task;
  store: FolderStore;
  record: RecordObservation;
  navigation: PluginScreenProps["navigation"];
}

export function FolderDispatch({
  hostId,
  project,
  projectKey,
  task,
  store,
  record,
  navigation,
}: Props) {
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const selection = useDestination(hostId, projectKey, preparing);
  const { workspace, profile } = selection;
  const prompt = brief(project, task);
  const run = task.run;
  async function launch(retry?: FolderRun) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      let attempt = retry;
      if (!attempt) {
        if (!workspace || !profile || !task.title.trim())
          throw new Error("Choisis un espace et un profil.");
        const saved = (await listDispatchProfiles(hostId)).find((p) => p.id === profile.id);
        if (!saved) {
          void selection.profiles.refetch();
          throw new Error("Ce profil n’est plus disponible.");
        }
        const model =
          saved.model?.trim() || (await defaultModel(hostId, workspace.id, saved.provider));
        const batch: FolderRun = {
          id: crypto.randomUUID(),
          taskIds: [String(task.id)],
          destination: {
            serverId: hostId,
            workspaceId: workspace.id,
            providerModel: saved.provider + "/" + model,
          },
          profile: {
            id: saved.id,
            modeId: saved.modeId?.trim() || undefined,
            thinkingOptionId: saved.thinkingOptionId?.trim() || undefined,
            featureValues: saved.featureValues,
          },
          title: task.title.trim(),
          prompt,
          state: "launching",
          files: task.images?.map((i) => i.file) ?? [],
        };
        await store.write((board) => {
          const current = board.items.find((t) => t.id === task.id);
          if (
            !current ||
            current.status === 3 ||
            current.run?.id !== run?.id ||
            (current.run && current.run.state !== "failed")
          )
            throw new Error("Cette tâche a changé. Rouvre sa fiche.");
          return {
            ...board,
            items: board.items.map((t) => (t.id === task.id ? { ...t, run: batch } : t)),
          };
        });
        attempt = batch;
      }
      const images = await Promise.all(attempt.files.map(encodeImage));
      await launchBatch(attempt, record, images);
      setPreparing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Envoi non confirmé. Réessaie.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="dispatch folderDispatch">
      {run && (
        <RunControls
          run={run}
          task={task}
          navigation={navigation}
          busy={busy}
          retry={() => void launch(run)}
        />
      )}
      {(!run || run.state === "failed") &&
        task.status !== 3 &&
        (preparing ? (
          <DispatchPreview
            selection={selection}
            project={project}
            task={task}
            prompt={prompt}
            busy={busy}
            cancel={() => setPreparing(false)}
            submit={() => void launch()}
          />
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!task.title.trim()}
            onClick={() => {
              selection.chooseProfile(defaultProfileForHost(hostId));
              setPreparing(true);
            }}
          >
            Confier à un agent
          </button>
        ))}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

async function defaultModel(hostId: string, workspaceId: string, provider: string) {
  const api = getPaseoClient(hostId);
  const cwd = (await api.workspaces.ref(workspaceId).refresh())?.workspaceDirectory;
  if (!cwd) throw new Error("Espace indisponible.");
  const catalog = await api.providers.listModels(provider, { cwd });
  const selectable = catalog.models?.filter((m) => m.isSelectable !== false);
  const model = (selectable?.find((m) => m.isDefault) ?? selectable?.[0])?.id;
  if (!model) throw new Error("Aucun modèle disponible pour ce profil.");
  return model;
}
async function listDispatchProfiles(hostId: string) {
  const { config } = await getPaseoClient(hostId).config.get();
  return (config.agentProfiles ?? []).filter((p) => !/^workflow/i.test(p.name.trimStart()));
}

// The web app stores the default selected in Agent profiles per host, on this device.
function defaultProfileForHost(hostId: string): string {
  try {
    const raw = window.localStorage.getItem("@paseo:create-agent-preferences");
    const id = raw && JSON.parse(raw)?.defaultAgentProfileByHost?.[hostId];
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

export function findBoardProjectHost(
  directory: readonly PluginProjectSummary[],
  hostId: string,
  projectKey: string,
) {
  const matches = directory.filter(
    (p) =>
      p.viewKey === projectKey ||
      (p.viewKey.startsWith("host:" + hostId + ":") && p.viewKey.endsWith("/" + projectKey)),
  );
  return matches.length === 1 ? matches[0]?.hosts.find((h) => h.serverId === hostId) : undefined;
}

function useDestination(hostId: string, projectKey: string, preparing: boolean) {
  const [workspaceChoice, chooseWorkspace] = useState("");
  const [profileChoice, chooseProfile] = useState("");
  const directory = useProjects();
  const project = findBoardProjectHost(directory.projects, hostId, projectKey);
  const target = project?.isOnline ? project : undefined;
  const spaces = target?.workspaces.filter((w) => !w.archivingAt) ?? [];
  const workspace =
    spaces.find((w) => w.id === workspaceChoice) ?? (spaces.length === 1 ? spaces[0] : undefined);
  const profiles = useQuery({
    queryKey: ["projets", "dispatch-profiles", hostId],
    enabled: preparing && !!target,
    queryFn: () => listDispatchProfiles(hostId),
    retry: false,
  });
  const options = profiles.data ?? [];
  const profile = options.find((p) => p.id === profileChoice);
  return {
    directory,
    target,
    spaces,
    workspace,
    profiles,
    options,
    profile,
    chooseWorkspace,
    chooseProfile,
  };
}
function RunControls({
  run,
  task,
  navigation,
  busy,
  retry,
}: Pick<Props, "task" | "navigation"> & { run: FolderRun; busy: boolean; retry(): void }) {
  const statusLabel =
    run &&
    {
      launching: "Envoi à confirmer",
      running: "Agent en cours",
      review: task.status === 3 ? "Terminée" : "À vérifier",
      failed: "Agent interrompu",
      unknown: "Suivi indisponible",
    }[run.state];
  return (
    <div className="dispatchActions">
      <strong>{statusLabel}</strong>
      {run.state !== "launching" &&
        (run.state !== "failed" || run.turnId) &&
        navigation?.openAgent && (
          <button
            type="button"
            onClick={() =>
              navigation.openAgent?.({ serverId: run.destination.serverId, agentId: run.id })
            }
          >
            Ouvrir l’agent
          </button>
        )}
      {run.state === "launching" && (
        <button type="button" disabled={busy} onClick={() => retry()}>
          {busy ? "Envoi…" : "Réessayer l’envoi"}
        </button>
      )}
    </div>
  );
}
function DispatchPreview({
  selection,
  project,
  task,
  prompt,
  busy,
  cancel,
  submit,
}: Pick<Props, "project" | "task"> & {
  selection: ReturnType<typeof useDestination>;
  prompt: string;
  busy: boolean;
  cancel(): void;
  submit(): void;
}) {
  const { directory, spaces, workspace, profiles, profile, chooseWorkspace } = selection;
  return (
    <>
      <strong>Aperçu de l’envoi</strong>
      <pre>{prompt}</pre>
      {task.images?.length ? (
        <ul>
          {task.images.map((i) => (
            <li key={i.id}>{i.file.name}</li>
          ))}
        </ul>
      ) : null}
      {spaces.length ? (
        <label>
          Espace
          <select
            aria-label="Espace de l’agent"
            value={workspace?.id ?? ""}
            onChange={(e) => chooseWorkspace(e.target.value)}
          >
            {!workspace && <option value="">Choisir un espace</option>}
            {spaces.map((w) => (
              <option key={w.id} value={w.id}>
                {project} · {w.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span>{directory.isLoading ? "Chargement…" : "Aucun espace connecté pour ce projet."}</span>
      )}
      <ProfilePicker selection={selection} busy={busy} />
      <div className="dispatchActions">
        <button type="button" disabled={busy} onClick={() => cancel()}>
          Annuler
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !workspace || !profile || profiles.isError || !task.title.trim()}
          onClick={() => submit()}
        >
          {busy ? "Envoi…" : "Lancer l’agent"}
        </button>
      </div>
    </>
  );
}

function ProfilePicker({
  selection,
  busy,
}: {
  selection: ReturnType<typeof useDestination>;
  busy: boolean;
}) {
  const { target, options, profile, chooseProfile, profiles } = selection;
  return (
    <>
      {" "}
      {target && (
        <label>
          Profil
          <select
            aria-label="Profil d’agent"
            value={profile?.id ?? ""}
            disabled={busy || !options.length || profiles.isError}
            onChange={(e) => chooseProfile(e.target.value)}
          >
            <option value="">{profiles.isLoading ? "Chargement…" : "Choisir un profil"}</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {target && profiles.isSuccess && !options.length && <span>Aucun profil disponible.</span>}
      {profiles.isError && (
        <button type="button" onClick={() => void profiles.refetch()}>
          Recharger les profils
        </button>
      )}
    </>
  );
}
