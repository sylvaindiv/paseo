import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  currentProjectPhase,
  groupProjectTasks,
  readProjectTodos,
  writeProjectTodo,
  type BatchDestination,
  type ProjectBatch,
  type ProjectTodoList,
  type ProjectPhase as ProjectPhaseData,
  type ProjectTask,
} from "../shared/project-todos.js";
import { launchBatch, type createBatchTracking, type RecordObservation } from "./batch-tracking.js";
import {
  InlineTodo,
  QuickAdd,
  TaskControlStyles,
  type Change,
  type TaskMenuRequest,
} from "./inline-todo.js";
import { ProjectMenu } from "./project-menu.js";
import { TaskDragBoard } from "./task-drag.js";
import { ProjectPhase, type PhaseTaskControls } from "./project-phase.js";
import { ProjectButton } from "./project-button.js";
import {
  DispatchBatch,
  DispatchQueue,
  DispatchTasks,
  type AgentDestination,
} from "./project-dispatch.js";
import { projectColors, type ProjectStyles } from "./styles.js";

type Navigation = PluginScreenProps["navigation"];
const EMPTY_TASKS: ProjectTask[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_BATCHES: ProjectBatch[] = [];
interface ProjectTasksProps {
  name: string;
  addingPhase: boolean;
  closeAddPhase(): void;
  hostId: string;
  projectKey: string;
  legacySelection?: string[];
  destinations: AgentDestination[];
  navigation?: Navigation;
  disabled: boolean;
  theme: PluginScreenProps["theme"];
  styles: ProjectStyles;
  tracking: ReturnType<typeof createBatchTracking>;
}

export function ProjectTasks(props: ProjectTasksProps) {
  const { hostId, projectKey, styles, legacySelection } = props;
  const read = useRpc(readProjectTodos);
  const save = useRpc(writeProjectTodo);
  const load = useCallback(async () => {
    const list = await read({ projectKey });
    if (!list.dispatch?.legacyImported && legacySelection?.length) {
      await save({ projectKey, change: { operation: "queue-import", taskIds: legacySelection } });
      return read({ projectKey });
    }
    return list;
  }, [legacySelection, projectKey, read, save]);
  const queryKey = useMemo(() => ["projets", "todos", hostId, projectKey], [hostId, projectKey]);
  const query = useQuery({ queryKey, queryFn: load, refetchInterval: 8_000, retry: false });
  const { refetch, data } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (data)
    return (
      <ProjectTodoContent
        {...props}
        data={data}
        queryKey={queryKey}
        stale={query.isError}
        refresh={refresh}
      />
    );
  return (
    <View style={styles.body}>
      {query.isError ? (
        <View style={styles.listBar}>
          <Text style={styles.message} accessibilityRole="alert">
            Liste indisponible
          </Text>
          <ProjectButton onPress={refresh}>Réessayer</ProjectButton>
        </View>
      ) : (
        <Text style={styles.message}>Chargement…</Text>
      )}
    </View>
  );
}

function ProjectTodoContent(
  props: ProjectTasksProps & {
    data: ProjectTodoList;
    queryKey: string[];
    stale: boolean;
    refresh(): void;
  },
) {
  const {
    data,
    projectKey,
    hostId,
    queryKey,
    stale,
    refresh,
    name,
    addingPhase,
    closeAddPhase,
    destinations,
    navigation,
    disabled,
    theme,
    styles,
    tracking,
  } = props;
  const save = useRpc(writeProjectTodo);
  const client = useQueryClient();
  const [actions, setActions] = useState<TaskMenuRequest>();
  const [sending, setSending] = useState<string[]>();
  const toast = useToast();
  const closeTaskAction = useCallback(() => setActions(undefined), []);

  const { phases, tasks, dispatch } = data;
  const batches = dispatch?.batches ?? EMPTY_BATCHES;
  const queue = dispatch?.queue ?? EMPTY_IDS;
  const reserved = useMemo(() => new Set(batches.flatMap((batch) => batch.taskIds)), [batches]);
  const queueBlocked = useMemo(() => new Set([...queue, ...reserved]), [queue, reserved]);
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const queueTasks = queue.flatMap((id) => {
    const task = tasksById.get(id);
    return task ? [task] : [];
  });
  const openDispatch = useCallback(
    () => setSending(queue.filter((id) => !reserved.has(id))),
    [queue, reserved],
  );
  const closeDispatch = useCallback((open: boolean) => {
    if (!open) setSending(undefined);
  }, []);
  const [openPhases, setOpenPhases] = useState(() => new Set([currentProjectPhase(phases)?.id]));
  const showPhase = useCallback(
    (id: string) => setOpenPhases((open) => new Set([...open, id])),
    [],
  );
  const togglePhase = useCallback((id: string) => {
    setOpenPhases((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const { foregroundMuted: muted } = projectColors;

  const mutate = useCallback((change: Change) => save({ projectKey, change }), [projectKey, save]);
  const refreshList = useCallback(() => client.invalidateQueries({ queryKey }), [client, queryKey]);
  const write = useCallback(
    async (change: Change) => {
      await mutate(change);
      void client.invalidateQueries({ queryKey: ["projets", "overview", hostId] });
      await refreshList();
      if (change.operation === "phase-move" || change.operation === "phase-add")
        showPhase(change.phaseId);
    },
    [client, hostId, mutate, refreshList, showPhase],
  );
  const record = useCallback<RecordObservation>(
    async (batchId, state, turnId) => {
      const result = await mutate({ operation: "batch-observe", batchId, state, turnId });
      void refreshList();
      return result.batch;
    },
    [mutate, refreshList],
  );
  useEffect(() => {
    for (const batch of batches) {
      if (batch.state === "review" || batch.state === "failed") tracking.stop(batch.id);
      else tracking.watch(batch, record);
    }
  }, [batches, record, tracking]);
  const launch = useCallback((batch: ProjectBatch) => launchBatch(batch, record), [record]);
  const send = useCallback(
    async (batchId: string, taskIds: string[], destination: BatchDestination) => {
      const { batch } = await mutate({
        operation: "batch-reserve",
        batchId,
        taskIds,
        projectName: name,
        destination,
      });
      if (!batch) throw new Error("Lot indisponible");
      if (batch.state !== "launching") return;
      try {
        await launch(batch);
      } catch {
        toast.error("Lancement non confirmé");
      } finally {
        void refreshList();
      }
    },
    [launch, mutate, name, refreshList, toast],
  );
  const add = useCallback(
    (title: string, phaseId: string) => write({ operation: "phase-add", phaseId, title }),
    [write],
  );
  const groups = useMemo(() => groupProjectTasks(phases, tasks), [phases, tasks]);
  const actionTask = tasks.find((task) => task.id === actions?.id);
  const actionPhase = phases.find((phase) => phase.name === actionTask?.stage) ?? phases[0];
  const nearbyTasks = useMemo(
    () =>
      (groups.get(actionPhase?.id ?? "") ?? EMPTY_TASKS).filter(
        (task) => task.completed === actionTask?.completed,
      ),
    [actionPhase?.id, actionTask?.completed, groups],
  );
  const otherPhases = useMemo(
    () => phases.filter((phase) => phase.id !== actionPhase?.id),
    [actionPhase?.id, phases],
  );

  const taskRow = useCallback(
    (task: ProjectTask, options?: PhaseTaskControls) => {
      return (
        <InlineTodo
          key={task.id}
          task={task}
          queued={queue.includes(task.id)}
          canSelect={!disabled && !stale && !reserved.has(task.id)}
          write={write}
          styles={styles}
          muted={muted}
          actions={setActions}
          {...options}
        />
      );
    },
    [disabled, muted, queue, reserved, stale, styles, write],
  );

  return (
    <View style={styles.body} testID="projets-local-list">
      <TaskControlStyles />
      {addingPhase ? (
        <QuickAdd
          accessibilityLabel={"Nouvelle phase pour " + name}
          placeholder="Nouvelle phase"
          onAdd={add}
          cancel={closeAddPhase}
          muted={muted}
          styles={styles}
        />
      ) : null}
      {stale ? (
        <View style={styles.listBar}>
          <Text style={styles.message} accessibilityRole="alert">
            Liste indisponible
          </Text>
          <ProjectButton onPress={refresh}>Réessayer</ProjectButton>
        </View>
      ) : null}
      <TaskDragBoard
        phases={phases}
        groups={groups}
        queueBlocked={queueBlocked}
        write={write}
        styles={styles}
      >
        <DispatchQueue
          tasks={queueTasks}
          reserved={reserved}
          stale={stale}
          hasDestination={destinations.length > 0}
          open={openDispatch}
          write={write}
          styles={styles}
        />
        {[...batches]
          .sort((a, b) => Number(b.state === "review") - Number(a.state === "review"))
          .map((batch) => (
            <DispatchBatch
              key={batch.id}
              batch={batch}
              tasks={batch.taskIds.flatMap((id) => {
                const task = tasksById.get(id);
                return task && !task.completed ? [task] : [];
              })}
              navigation={navigation}
              write={write}
              launch={launch}
              styles={styles}
            />
          ))}
        {phases.map((phase, index) => (
          <ProjectPhase
            key={phase.id}
            phase={phase}
            tasks={groups.get(phase.id) ?? EMPTY_TASKS}
            open={openPhases.has(phase.id)}
            toggle={togglePhase}
            canDelete={index > 0}
            canReorder={phases.length > 1}
            plain={
              phases.length === 1 &&
              phase.id === "default" &&
              phase.name === "Phase 1" &&
              !phase.status
            }
            write={write}
            taskRow={taskRow}
            styles={styles}
            muted={muted}
            colors={projectColors}
          />
        ))}
      </TaskDragBoard>
      {actionTask && actionPhase && actions ? (
        <TaskMenu
          task={actionTask}
          request={actions}
          colors={projectColors}
          tasks={nearbyTasks}
          otherPhases={otherPhases}
          write={write}
          close={closeTaskAction}
          styles={styles}
        />
      ) : null}
      {sending ? (
        <DispatchTasks
          name={name}
          taskIds={sending}
          destinations={destinations}
          send={send}
          close={closeDispatch}
          theme={theme}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

function TaskMenu({
  task,
  request,
  colors,
  tasks,
  otherPhases,
  write,
  close,
  styles,
}: {
  task: ProjectTask;
  request: TaskMenuRequest;
  colors: PluginScreenProps["theme"]["colors"];
  tasks: ProjectTask[];
  otherPhases: ProjectPhaseData[];
  write(change: Change): Promise<void>;
  close(): void;
  styles: ProjectStyles;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const index = tasks.findIndex((entry) => entry.id === task.id);
  const change = useCallback(
    async (mutation: Change) => {
      setPending(true);
      try {
        await write(mutation);
        close();
      } catch {
        toast.error("Modification non enregistrée");
      } finally {
        setPending(false);
      }
    },
    [close, toast, write],
  );
  const move = useCallback(
    (offset: number) => {
      const next = tasks[index + offset];
      if (next)
        void change({
          operation: "reorder",
          ids: offset > 0 ? [next.id, task.id] : [task.id, next.id],
        });
    },
    [change, index, task.id, tasks],
  );
  const up = useCallback(() => move(-1), [move]);
  const down = useCallback(() => move(1), [move]);
  const moveToPhase = useCallback(
    (phaseId: string) => void change({ operation: "phase-move", taskId: task.id, phaseId }),
    [change, task.id],
  );
  const ask = useCallback(() => setConfirm(true), []);
  const remove = useCallback(() => {
    void change({ operation: "delete", taskId: task.id });
  }, [change, task.id]);
  const edit = useCallback(() => {
    close();
    request.edit();
  }, [close, request]);
  const select = useCallback(() => {
    void change({ operation: "queue-task", taskId: task.id, queued: !request.selected });
  }, [change, request.selected, task.id]);
  const duplicate = useCallback(
    () =>
      void change({
        operation: "duplicate",
        taskId: task.id,
        copyId: globalThis.crypto.randomUUID(),
      }),
    [change, task.id],
  );
  const items = useMemo(
    () => [
      { icon: "Pencil", label: "Modifier", onPress: edit },
      { icon: "Copy", label: "Dupliquer", onPress: duplicate },
      { icon: "ArrowUp", label: "Monter", onPress: up, disabled: index <= 0 },
      {
        icon: "ArrowDown",
        label: "Descendre",
        onPress: down,
        disabled: index < 0 || index === tasks.length - 1,
      },
      ...otherPhases.map((phase) => ({
        icon: "FolderInput",
        label: "Déplacer vers " + phase.name,
        onPress: () => moveToPhase(phase.id),
      })),
      ...(request.canSelect
        ? [
            {
              icon: request.selected ? "ListChecks" : "ListPlus",
              label: request.selected ? "Retirer de l’envoi" : "Ajouter à « À envoyer »",
              onPress: select,
            },
          ]
        : []),
      {
        icon: "Trash2",
        label: confirm ? "Confirmer la suppression" : "Supprimer",
        onPress: confirm ? remove : ask,
      },
    ],
    [
      confirm,
      down,
      duplicate,
      edit,
      index,
      moveToPhase,
      otherPhases,
      remove,
      request,
      select,
      tasks.length,
      up,
      ask,
    ],
  );
  return (
    <ProjectMenu
      anchor={request.anchor}
      title={task.title}
      pending={pending}
      close={close}
      colors={colors}
      styles={styles}
      items={items}
    />
  );
}
