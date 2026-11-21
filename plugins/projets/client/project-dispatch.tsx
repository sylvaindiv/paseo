import { useQuery } from "@tanstack/react-query";
import { getPaseoClient, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { Button } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type BatchDestination,
  type ProjectBatch,
  type ProjectTask,
} from "../shared/project-todos.js";
import { TaskAction, type Change } from "./inline-todo.js";
import { ProjectButton } from "./project-button.js";
import { projectColors, type ProjectStyles } from "./styles.js";
import { TaskQueueDrop } from "./task-drag.js";

export interface AgentDestination {
  id: string;
  name: string;
  serverId: string;
  serverName: string;
}

interface QueueProps {
  tasks: ProjectTask[];
  reserved: ReadonlySet<string>;
  stale: boolean;
  hasDestination: boolean;
  open(): void;
  write(change: Change): Promise<void>;
  styles: ProjectStyles;
}

export function DispatchQueue(props: QueueProps) {
  return (
    <TaskQueueDrop>
      {(dragging, over) => <QueueSurface {...props} dragging={dragging} over={over} />}
    </TaskQueueDrop>
  );
}

function QueueSurface({
  tasks,
  reserved,
  stale,
  hasDestination,
  open,
  write,
  styles,
  dragging,
  over,
}: QueueProps & { dragging: boolean; over: boolean }) {
  const count = tasks.filter((task) => !reserved.has(task.id)).length;
  const filled = tasks.length > 0;
  const surface = useMemo(
    () => [
      styles.queue,
      filled && styles.queueFilled,
      dragging && styles.queueDrag,
      over && styles.queueOver,
    ],
    [dragging, filled, over, styles],
  );
  return (
    <View testID="projets-queue" style={surface}>
      <View style={styles.listBar}>
        <Text style={styles.queueTitle}>À envoyer{tasks.length ? " · " + tasks.length : ""}</Text>
        {tasks.length ? (
          <ProjectButton
            primary
            onPress={open}
            disabled={!hasDestination || stale || !count}
            testID="projets-send"
          >
            Envoyer{count ? " · " + count : ""}
          </ProjectButton>
        ) : null}
      </View>
      {tasks.map((task) => (
        <QueuedTask
          key={task.id}
          task={task}
          reserved={reserved.has(task.id)}
          write={write}
          styles={styles}
        />
      ))}
      {dragging ? <Text style={styles.queueHint}>Déposer ici</Text> : null}
      {count > 0 && !hasDestination ? (
        <Text style={styles.queueHint}>Aucun espace disponible</Text>
      ) : null}
    </View>
  );
}

function QueuedTask({
  task,
  reserved,
  write,
  styles,
}: {
  task: ProjectTask;
  reserved: boolean;
  write(change: Change): Promise<void>;
  styles: ProjectStyles;
}) {
  const toast = useToast();
  const remove = useCallback(
    () =>
      void write({ operation: "queue-task", taskId: task.id, queued: false }).catch(() =>
        toast.error("Tâche non retirée"),
      ),
    [task.id, toast, write],
  );
  return (
    <View style={styles.queueRow}>
      <Text style={styles.queueTask}>{task.title}</Text>
      {reserved ? (
        <Text style={styles.small}>Envoi à confirmer</Text>
      ) : (
        <TaskAction
          styles={styles}
          icon="X"
          label={"Retirer " + task.title + " de l’envoi"}
          color={projectColors.foregroundMuted}
          onPress={remove}
        />
      )}
    </View>
  );
}

export function DispatchBatch({
  batch,
  tasks,
  navigation,
  write,
  launch,
  styles,
}: {
  batch: ProjectBatch;
  tasks: ProjectTask[];
  navigation?: PluginScreenProps["navigation"];
  write(change: Change): Promise<void>;
  launch(batch: ProjectBatch): Promise<void>;
  styles: ProjectStyles;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string>();
  const busy = useRef(false);
  const toast = useToast();
  const review = batch.state === "review";
  const running = batch.state === "running";
  const label = {
    launching: "Envoi à confirmer",
    running: "En cours",
    review: "À vérifier",
    failed: "Interrompu",
    unknown: "Suivi indisponible",
  }[batch.state];
  const openAgent = navigation?.openAgent;
  const act = useCallback(
    async (id: string, action: () => Promise<void>, error: string) => {
      if (busy.current) return;
      busy.current = true;
      setPending(id);
      try {
        await action();
      } catch {
        toast.error(error);
      } finally {
        busy.current = false;
        setPending(undefined);
      }
    },
    [toast],
  );
  const toggle = useCallback(() => setExpanded((open) => !open), []);
  const open = useCallback(
    () => openAgent?.({ agentId: batch.id, serverId: batch.destination.serverId }),
    [batch.destination.serverId, batch.id, openAgent],
  );
  const retry = useCallback(
    () => void act(batch.id, () => launch(batch), "Lancement non confirmé"),
    [act, batch, launch],
  );
  const requeue = useCallback(
    () =>
      void act(
        batch.id,
        () => write({ operation: "batch-requeue", batchId: batch.id }),
        "Lot non remis à envoyer",
      ),
    [act, batch.id, write],
  );
  const validate = useCallback(
    (id: string) =>
      void act(
        id,
        () => write({ operation: "update", taskId: id, status: "done" }),
        "Tâche non validée",
      ),
    [act, write],
  );
  const surface = useMemo(
    () => [styles.batchSection, review && styles.reviewSection],
    [review, styles],
  );
  return (
    <View style={surface} testID={"projets-batch-" + batch.state}>
      <View style={styles.listBar}>
        {running ? (
          <Pressable
            style={styles.batchToggle}
            accessibilityRole="button"
            aria-expanded={expanded}
            onPress={toggle}
          >
            <Icon
              name={expanded ? "ChevronDown" : "ChevronRight"}
              size={13}
              color={projectColors.foregroundMuted}
            />
            <Text style={styles.message}>
              {label} · {tasks.length}
            </Text>
          </Pressable>
        ) : (
          <Text style={review ? styles.reviewTitle : styles.message}>
            {label} · {tasks.length}
          </Text>
        )}
        {openAgent && batch.state !== "launching" && (batch.state !== "failed" || batch.turnId) ? (
          <Pressable style={styles.batchAction} accessibilityRole="button" onPress={open}>
            <Text style={styles.batchActionLabel}>Ouvrir l’agent</Text>
          </Pressable>
        ) : null}
        {batch.state === "launching" ? (
          <ProjectButton disabled={Boolean(pending)} onPress={retry}>
            Réessayer
          </ProjectButton>
        ) : null}
        {batch.state === "failed" ? (
          <ProjectButton disabled={Boolean(pending)} onPress={requeue}>
            Remettre à envoyer
          </ProjectButton>
        ) : null}
      </View>
      {review || (running && expanded) || batch.state === "failed" || batch.state === "unknown" ? (
        <View style={styles.batchDetail}>
          {tasks.map((task) =>
            review ? (
              <ReviewTask
                key={task.id}
                task={task}
                busy={pending === task.id}
                disabled={Boolean(pending)}
                validate={validate}
                styles={styles}
              />
            ) : (
              <Text key={task.id} style={styles.queueTask}>
                {task.title}
              </Text>
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

function ReviewTask({
  task,
  busy,
  disabled,
  validate,
  styles,
}: {
  task: ProjectTask;
  busy: boolean;
  disabled: boolean;
  validate(id: string): void;
  styles: ProjectStyles;
}) {
  const press = useCallback(() => validate(task.id), [task.id, validate]);
  const state = useMemo(() => ({ checked: false, busy }), [busy]);
  return (
    <Pressable
      style={styles.queueRow}
      accessibilityRole="checkbox"
      accessibilityLabel={"Valider " + task.title}
      accessibilityState={state}
      disabled={disabled}
      onPress={press}
    >
      <View style={styles.checkbox} />
      <Text style={styles.queueTask}>{task.title}</Text>
    </Pressable>
  );
}

export function DispatchTasks({
  name,
  taskIds,
  destinations,
  send,
  close,
  theme,
  styles,
}: {
  name: string;
  taskIds: string[];
  destinations: AgentDestination[];
  send(batchId: string, taskIds: string[], destination: BatchDestination): Promise<void>;
  close(open: boolean): void;
  theme: PluginScreenProps["theme"];
  styles: ProjectStyles;
}) {
  const [destination, setDestination] = useState(
    destinations.length === 1 ? destinationKey(destinations[0]!) : "",
  );
  const selected = destinations.find((item) => destinationKey(item) === destination);
  const [providerId, setProvider] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const { foreground, foregroundMuted } = theme.colors;
  const titleStyle = useMemo(
    () => [styles.groupTitle, { color: foreground }],
    [foreground, styles],
  );
  const noticeStyle = useMemo(
    () => [styles.message, { color: foregroundMuted }],
    [foregroundMuted, styles],
  );
  const errorStyle = useMemo(() => [styles.taskError, { color: foreground }], [foreground, styles]);
  const chooseDestination = useCallback((id: string) => {
    setDestination(id);
    setProvider("");
    setError("");
  }, []);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!active.current) close(open);
    },
    [close],
  );
  const options = useQuery({
    queryKey: ["projets", "agent-providers", selected?.serverId],
    enabled: Boolean(selected),
    queryFn: async () => {
      const data = await getPaseoClient(selected!.serverId).providers.listAvailable();
      return data.providers.filter((entry) => entry.available).map((entry) => entry.provider);
    },
    retry: false,
  });
  const providers = options.data ?? [];
  const provider = providers.includes(providerId) ? providerId : providers[0];

  const submit = useCallback(async () => {
    if (!selected || !provider || active.current || taskIds.length === 0) return;
    active.current = true;
    setPending(true);
    setError("");
    try {
      const api = getPaseoClient(selected.serverId);
      const cwd = (await api.workspaces.ref(selected.id).refresh())?.workspaceDirectory;
      if (!cwd) {
        setError("Espace indisponible");
        return;
      }
      const catalog = await api.providers.listModels(provider, { cwd });
      const models = catalog.models?.filter((model) => model.isSelectable !== false) ?? [];
      const model = models.find((item) => item.isDefault) ?? models[0];
      if (!model) {
        setError("Aucun modèle disponible");
        return;
      }
      const target = {
        serverId: selected.serverId,
        workspaceId: selected.id,
        providerModel: provider + "/" + model.id,
      };
      const key = JSON.stringify([target, taskIds]);
      if (attempt.current?.key !== key)
        attempt.current = { key, id: globalThis.crypto.randomUUID() };
      await send(attempt.current.id, taskIds, target);
      close(false);
    } catch {
      setError("Envoi non confirmé. Réessaie.");
    } finally {
      active.current = false;
      setPending(false);
    }
  }, [close, provider, selected, send, taskIds]);

  return (
    <Modal title={"Nouvel agent · " + name} open onOpenChange={onOpenChange}>
      <Modal.Content>
        <View style={styles.options}>
          <Text style={titleStyle}>
            {taskIds.length} {taskIds.length === 1 ? "tâche à envoyer" : "tâches à envoyer"}
          </Text>
          {destinations.map((item) => (
            <Choice
              key={destinationKey(item)}
              id={destinationKey(item)}
              label={item.name + " · " + item.serverName}
              disabled={pending || item === selected}
              select={chooseDestination}
            />
          ))}
          {providers.map((item) => (
            <Choice
              key={item}
              id={item}
              label={item}
              disabled={pending || item === provider}
              select={setProvider}
            />
          ))}
          {selected && (options.isError || (options.data && !providers.length)) ? (
            <Text style={noticeStyle}>Aucun agent disponible</Text>
          ) : null}
          {error ? (
            <Text style={errorStyle} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Button
            size="sm"
            onPress={submit}
            disabled={pending || !provider || !selected}
            loading={pending}
          >
            Lancer l’agent
          </Button>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function destinationKey(destination: AgentDestination) {
  return JSON.stringify([destination.serverId, destination.id]);
}

function Choice({
  id,
  label,
  disabled,
  select,
}: {
  id: string;
  label: string;
  disabled: boolean;
  select(id: string): void;
}) {
  const onPress = useCallback(() => select(id), [id, select]);
  return (
    <Button size="sm" disabled={disabled} onPress={onPress}>
      {label}
    </Button>
  );
}
