import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  phaseStatuses,
  type ProjectPhase as ProjectPhaseData,
  type ProjectTask,
} from "../shared/project-todos.js";
import { QuickAdd, TaskAction, type Change, type TaskDraft } from "./inline-todo.js";
import { SortableTitleBar } from "./sortable-controls.js";
import { ProjectMenu } from "./project-menu.js";
import { SortableTask, TaskDropPhase } from "./task-drag.js";
import type { ProjectStyles } from "./styles.js";

export function ProjectPhase({
  phase,
  tasks,
  open,
  toggle,
  canDelete,
  canReorder,
  write,
  taskRow,
  styles,
  muted,
  colors,
  plain = false,
}: {
  phase: ProjectPhaseData;
  tasks: ProjectTask[];
  open: boolean;
  toggle(id: string): void;
  canDelete: boolean;
  canReorder: boolean;
  write(change: Change): Promise<void>;
  taskRow(task: ProjectTask, options?: PhaseTaskControls): ReactNode;
  styles: ProjectStyles;
  muted: string;
  colors: PluginScreenProps["theme"]["colors"];
  plain?: boolean;
}) {
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>();
  const [actions, setActions] = useState<{ anchor?: HTMLElement }>();
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const writing = useRef(false);
  const toast = useToast();
  const active = useMemo(() => tasks.filter((task) => !task.completed), [tasks]);
  const done = tasks.filter((task) => task.completed);
  const toggleOpen = useCallback(() => toggle(phase.id), [phase.id, toggle]);
  const toggleDone = useCallback(() => setShowDone((shown) => !shown), []);
  const createBelow = useCallback(
    (afterTaskId: string) =>
      setDraft({ id: globalThis.crypto.randomUUID(), afterTaskId, saved: false }),
    [],
  );
  const startAdd = useCallback(
    () => setDraft((current) => current ?? { id: globalThis.crypto.randomUUID(), saved: false }),
    [],
  );
  const closeDraft = useCallback(() => setDraft(undefined), []);
  const stopRename = useCallback(() => setRenaming(false), []);
  const openMenu = useCallback((anchor?: HTMLElement) => {
    setConfirm(false);
    setActions({ anchor });
  }, []);
  const closeMenu = useCallback(() => setActions(undefined), []);
  const startRename = useCallback(() => {
    setActions(undefined);
    setRenaming(true);
  }, []);
  const rename = useCallback(
    async (title: string) => {
      if (title !== phase.name)
        await write({ operation: "phase-rename", phaseId: phase.id, title });
      setRenaming(false);
    },
    [phase.id, phase.name, write],
  );
  const apply = useCallback(
    async (change: Change) => {
      if (writing.current) return;
      writing.current = true;
      setPending(true);
      try {
        await write(change);
        setActions(undefined);
      } catch {
        toast.error("Phase non enregistrée");
      } finally {
        writing.current = false;
        setPending(false);
      }
    },
    [toast, write],
  );
  const remove = useCallback(() => {
    if (confirm) void apply({ operation: "phase-delete", phaseId: phase.id });
    else setConfirm(true);
  }, [apply, confirm, phase.id]);

  const menuItems = useMemo(
    () => [
      { icon: "Pencil", label: "Renommer", onPress: startRename },
      ...(canDelete
        ? [
            {
              icon: "Trash2",
              label: confirm ? "Confirmer la suppression" : "Supprimer la phase",
              onPress: remove,
            },
          ]
        : []),
    ],
    [canDelete, confirm, remove, startRename],
  );

  return (
    <TaskDropPhase id={phase.id} tasks={active} canReorder={canReorder}>
      <View style={open ? styles.phaseOpen : undefined} testID={"projets-phase-" + phase.id}>
        {plain ? (
          <Pressable
            accessibilityRole="button"
            aria-expanded={open}
            onPress={toggleOpen}
            style={styles.plainPhaseHeader}
          >
            <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={muted} />
            <Text style={styles.phaseName}>Tâches</Text>
          </Pressable>
        ) : (
          <PhaseHeader
            phase={phase}
            open={open}
            toggle={toggleOpen}
            apply={apply}
            openMenu={openMenu}
            pending={pending}
            total={tasks.length}
            completed={done.length}
            styles={styles}
            muted={muted}
          />
        )}
        {renaming ? (
          <QuickAdd
            accessibilityLabel={"Renommer la phase " + phase.name}
            placeholder="Nom de la phase"
            initialValue={phase.name}
            styles={styles}
            muted={muted}
            cancel={stopRename}
            onAdd={rename}
          />
        ) : null}
        {open ? (
          <View style={styles.phaseBody}>
            <PhaseTaskRows
              active={active}
              draft={draft}
              closeDraft={closeDraft}
              phaseId={phase.id}
              createBelow={createBelow}
              taskRow={taskRow}
            />
            <Pressable accessibilityRole="button" onPress={startAdd} style={styles.phaseLink}>
              <Text style={styles.small}>+ Ajouter une tâche</Text>
            </Pressable>
            {done.length ? (
              <Pressable
                accessibilityRole="button"
                aria-expanded={showDone}
                onPress={toggleDone}
                style={styles.phaseDone}
              >
                <Text style={styles.phaseCount}>
                  {showDone ? "Masquer les tâches terminées" : "Terminées · " + done.length}
                </Text>
              </Pressable>
            ) : null}
            {showDone ? done.map((task) => taskRow(task)) : null}
          </View>
        ) : null}
        {actions ? (
          <ProjectMenu
            anchor={actions.anchor}
            title={phase.name}
            label={"Actions de la phase " + phase.name}
            colors={colors}
            styles={styles}
            pending={pending}
            close={closeMenu}
            items={menuItems}
          />
        ) : null}
      </View>
    </TaskDropPhase>
  );
}

export interface PhaseTaskControls {
  phaseId: string;
  createBelow(taskId: string): void;
  draft?: TaskDraft;
  closeDraft?(): void;
}

function PhaseTaskRows({
  active,
  draft,
  phaseId,
  closeDraft,
  createBelow,
  taskRow,
}: {
  active: ProjectTask[];
  draft?: TaskDraft;
  phaseId: string;
  closeDraft(): void;
  createBelow(taskId: string): void;
  taskRow(task: ProjectTask, options?: PhaseTaskControls): ReactNode;
}) {
  const tasks = active.filter((task) => task.id !== draft?.id);
  const draftIndex = draft?.afterTaskId
    ? tasks.findIndex((task) => task.id === draft.afterTaskId) + 1
    : tasks.length;
  if (draft) {
    tasks.splice(
      draftIndex || tasks.length,
      0,
      active.find((task) => task.id === draft.id) ?? {
        id: draft.id,
        title: "",
        stage: null,
        description: null,
        completed: false,
        order: 0,
        subtasks: [],
      },
    );
  }
  return tasks.map((task) =>
    task.id === draft?.id ? (
      taskRow(task, { phaseId, createBelow, draft, closeDraft })
    ) : (
      <SortableTask key={task.id} id={task.id}>
        {taskRow(task, { phaseId, createBelow })}
      </SortableTask>
    ),
  );
}

function PhaseHeader({
  phase,
  open,
  toggle,
  apply,
  openMenu,
  pending,
  total,
  completed,
  styles,
  muted,
}: {
  phase: ProjectPhaseData;
  open: boolean;
  toggle(): void;
  apply(change: Change): Promise<void>;
  openMenu(anchor?: HTMLElement): void;
  pending: boolean;
  total: number;
  completed: number;
  styles: ProjectStyles;
  muted: string;
}) {
  const status = phase.status ?? null;
  const current = status === "EN COURS";
  const cycle = useCallback(
    () =>
      void apply({
        operation: "phase-status",
        phaseId: phase.id,
        status: phaseStatuses[(phaseStatuses.indexOf(status) + 1) % phaseStatuses.length]!,
      }),
    [apply, phase.id, status],
  );
  const headerStyle = useMemo(
    () => [styles.phaseHeader, open && styles.phaseHeaderOpen],
    [open, styles],
  );
  const badge = useMemo(
    () => [
      styles.badge,
      status === "À PLANNIFIER" && styles.plannedOutline,
      current && styles.activeBadgeBackground,
      status === "EN ATTENTE" && styles.waitingBadgeBackground,
      status === "OK" && styles.doneBadgeBackground,
    ],
    [current, status, styles],
  );
  const badgeText = useMemo(
    () => [
      styles.badgeText,
      current && styles.activeBadge,
      status === "EN ATTENTE" && styles.waitingBadge,
      status === "OK" && styles.doneBadge,
    ],
    [current, status, styles],
  );
  const progress = useMemo(
    () => [styles.progressFill, { width: `${total ? (completed / total) * 100 : 0}%` as const }],
    [completed, styles, total],
  );
  return (
    <SortableTitleBar label={"Déplacer la phase " + phase.name}>
      <View style={headerStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={"Phase " + phase.name}
          aria-expanded={open}
          onPress={toggle}
          style={styles.phaseToggle}
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={"Changer l’état de " + phase.name + " · " + (status ?? "Sans état")}
          disabled={pending}
          style={badge}
          onPress={cycle}
        >
          <Text style={badgeText}>{status === "OK" ? "✓ FAIT" : (status ?? "—")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          aria-expanded={open}
          onPress={toggle}
          style={styles.phaseNameButton}
        >
          <Text numberOfLines={1} style={styles.phaseName}>
            {phase.name}
          </Text>
        </Pressable>
        {current && total ? (
          <View style={styles.progress}>
            <View style={progress} />
          </View>
        ) : null}
        <Text style={styles.phaseCount}>
          {current && total ? completed + "/" + total : total - completed || ""}
        </Text>
        <TaskAction
          icon="MoreHorizontal"
          label={"Actions de la phase " + phase.name}
          color={muted}
          styles={styles}
          onPress={openMenu}
        />
      </View>
    </SortableTitleBar>
  );
}
