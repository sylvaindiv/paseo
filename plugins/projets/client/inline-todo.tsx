import type { RpcInput } from "@getpaseo/plugin";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import { TaskNotes } from "./task-notes.js";
import { TaskTitle } from "./task-title.js";
import { titleActionWebProps } from "./sortable-controls.js";
import { projectColors, type ProjectStyles } from "./styles.js";
import type { ProjectTask, ProjectSubtask, writeProjectTodo } from "../shared/project-todos.js";

export type Change = RpcInput<typeof writeProjectTodo>["change"];

export function TaskAction({
  icon,
  label,
  color,
  onPress,
  styles,
  disabled,
  testID,
}: {
  icon: string;
  label: string;
  color: string;
  onPress(anchor?: HTMLElement): void;
  styles: ProjectStyles;
  disabled?: boolean;
  testID?: string;
}) {
  const press = useCallback(
    (event: GestureResponderEvent) => {
      const target = event.currentTarget;
      onPress(Platform.OS === "web" && target instanceof HTMLElement ? target : undefined);
    },
    [onPress],
  );
  return (
    <Pressable
      {...titleActionWebProps}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={press}
      style={styles.taskAction}
      testID={testID}
    >
      <Icon name={icon} size={15} color={color} />
    </Pressable>
  );
}

export function QuickAdd({
  accessibilityLabel,
  placeholder,
  initialValue = "",
  onAdd,
  styles,
  muted,
  cancel,
}: {
  accessibilityLabel: string;
  placeholder: string;
  initialValue?: string;
  onAdd(title: string, id: string): Promise<void>;
  styles: ProjectStyles;
  muted: string;
  cancel(): void;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const submitting = useRef(false);
  const attempt = useRef<{ title: string; id: string } | undefined>(undefined);
  const submit = useCallback(async () => {
    const title = value.trim();
    if (!title || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(false);
    try {
      if (attempt.current?.title !== title)
        attempt.current = { title, id: globalThis.crypto.randomUUID() };
      await onAdd(title, attempt.current.id);
      attempt.current = undefined;
      setValue("");
    } catch {
      setError(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }, [onAdd, value]);
  return (
    <View style={styles.addWrap}>
      <View style={styles.taskRow}>
        <TextInput
          autoFocus
          style={styles.quickInput}
          accessibilityLabel={accessibilityLabel}
          placeholder={placeholder}
          placeholderTextColor={muted}
          maxLength={1000}
          value={value}
          editable={!pending}
          onChangeText={setValue}
          onSubmitEditing={submit}
        />
        <TaskAction
          styles={styles}
          icon="Check"
          label="Valider l’ajout"
          color={muted}
          onPress={submit}
          disabled={pending || !value.trim()}
        />
        <TaskAction
          styles={styles}
          icon="X"
          label="Fermer l’ajout"
          color={muted}
          onPress={cancel}
        />
      </View>
      {error ? (
        <Text style={styles.taskError} accessibilityRole="alert">
          Ajout impossible. Réessaie.
        </Text>
      ) : null}
    </View>
  );
}

function ToggleDone({
  title,
  done,
  doing = false,
  subtask = false,
  reset,
  onChange,
  styles,
}: {
  title: string;
  done: boolean;
  doing?: boolean;
  subtask?: boolean;
  reset?(): Promise<void>;
  onChange(): Promise<void>;
  styles: ProjectStyles;
}) {
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const toggle = useCallback(async () => {
    setPending(true);
    try {
      await onChange();
    } catch {
      toast.error("Modification non enregistrée");
    } finally {
      setPending(false);
    }
  }, [onChange, toast]);
  const checked = doing ? ("mixed" as const) : done;
  const state = useMemo(() => ({ checked, disabled: pending }), [checked, pending]);
  const checkStyle = useMemo(
    () => [
      styles.checkbox,
      subtask && styles.subtaskCheckbox,
      done && styles.checked,
      doing && styles.doing,
    ],
    [doing, done, styles, subtask],
  );
  const target = subtask ? styles.subtaskCheckTarget : styles.checkTarget;
  const nextLabel = doing || subtask ? "Terminer " : "Commencer ";
  const button = (
    <Pressable
      style={target}
      accessibilityRole="checkbox"
      accessibilityLabel={(done ? "Rouvrir " : nextLabel) + title}
      accessibilityState={state}
      aria-checked={checked}
      onPress={toggle}
      disabled={pending}
    >
      <View style={checkStyle}>
        {done ? (
          <Icon name="Check" size={12} color={StyleSheet.flatten(styles.checkMark).color} />
        ) : null}
      </View>
    </Pressable>
  );
  const context = useCallback(
    (event: React.MouseEvent) => {
      if (!doing || !reset) return;
      event.preventDefault();
      void reset().catch(() => toast.error("Modification non enregistrée"));
    },
    [doing, reset, toast],
  );
  return Platform.OS === "web" ? (
    <span data-no-dnd="" onContextMenu={context}>
      {button}
    </span>
  ) : (
    button
  );
}

export interface TaskDraft {
  id: string;
  afterTaskId?: string;
  saved: boolean;
}

const notesField = Symbol("notes");

export interface TaskMenuRequest {
  id: string;
  anchor?: HTMLButtonElement;
  edit(): void;
  canSelect: boolean;
  selected: boolean;
}

export function InlineTodo({
  task,
  write,
  styles,
  muted,
  next = false,
  canSelect = false,
  actions,
  draft,
  phaseId,
  closeDraft,
  createBelow,
}: {
  task: ProjectTask;
  write(change: Change): Promise<void>;
  styles: ProjectStyles;
  muted: string;
  next?: boolean;
  canSelect?: boolean;
  actions(request: TaskMenuRequest): void;
  draft?: TaskDraft;
  phaseId?: string;
  closeDraft?(): void;
  createBelow?(taskId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [focus, setFocus] = useState<string | typeof notesField | undefined>(draft?.id);
  const [titleEditing, setTitleEditing] = useState(Boolean(draft));
  const [childDraft, setChildDraft] = useState<TaskDraft>();
  const children = useMemo(
    () =>
      childDraft && !task.subtasks.some((child) => child.id === childDraft.id)
        ? [...task.subtasks, { id: childDraft.id, title: "", completed: false }]
        : task.subtasks,
    [childDraft, task.subtasks],
  );
  const editing = focus !== undefined;
  const doing = !task.completed && task.status === "doing";
  const toggle = useCallback(
    () =>
      write({
        operation: "update",
        taskId: task.id,
        status: cycleTaskStatus(task.completed, doing),
      }),
    [doing, task.id, task.completed, write],
  );
  const reset = useCallback(
    () => write({ operation: "update", taskId: task.id, status: "todo" }),
    [task.id, write],
  );
  const rename = useCallback(
    async (title: string) => {
      if (draft && !draft.saved) {
        await write({
          operation: "add",
          taskId: task.id,
          title,
          phaseId,
          afterTaskId: draft.afterTaskId,
        });
        draft.saved = true;
        return;
      }
      await write({ operation: "update", taskId: task.id, title });
    },
    [draft, phaseId, task.id, write],
  );
  const deleteEmpty = useCallback(async () => {
    if ((!draft || draft.saved) && !task.description?.trim() && !task.subtasks.length) {
      await write({ operation: "delete", taskId: task.id });
    }
  }, [draft, task.description, task.id, task.subtasks.length, write]);
  const startTitle = useCallback(() => {
    setTitleEditing(true);
    setFocus(task.id);
  }, [task.id]);
  const stopTitle = useCallback(() => setTitleEditing(false), []);
  const focusNotes = useCallback(() => setFocus(notesField), []);
  const closeCard = useCallback(() => {
    setFocus(undefined);
    setTitleEditing(false);
    setChildDraft(undefined);
    closeDraft?.();
  }, [closeDraft]);
  const saveNotes = useCallback(
    async (description: string) => {
      const value = description.trim() || null;
      if (draft && !draft.saved) {
        if (!value) return;
        await write({
          operation: "add",
          taskId: task.id,
          title: "",
          description: value,
          phaseId,
          afterTaskId: draft.afterTaskId,
        });
        draft.saved = true;
        return;
      }
      await write({ operation: "update", taskId: task.id, description: value });
    },
    [draft, phaseId, task.id, write],
  );
  const addSibling = useCallback(() => {
    closeCard();
    createBelow?.(task.id);
  }, [closeCard, createBelow, task.id]);
  const addChild = useCallback(() => {
    if (childDraft && !childDraft.saved && focus !== childDraft.id) {
      setFocus(childDraft.id);
      return;
    }
    const id = globalThis.crypto.randomUUID();
    setChildDraft({ id, saved: false });
    setFocus(id);
  }, [childDraft, focus]);
  const focusFirstChild = useCallback(() => {
    const child = children[0];
    if (child) setFocus(child.id);
    else if (!draft || draft.saved) addChild();
  }, [addChild, children, draft]);
  const stopChild = useCallback((id: string) => {
    setFocus((current) => (current === id ? undefined : current));
    setChildDraft((current) => (current?.id === id ? undefined : current));
  }, []);
  const focusChild = useCallback(
    (index: number, direction: -1 | 1) => {
      const nextChild = children[index + direction];
      if (nextChild) setFocus(nextChild.id);
      else if (direction === -1) focusNotes();
      else addChild();
    },
    [addChild, children, focusNotes],
  );
  const openActions = useCallback(
    (anchor?: HTMLButtonElement) =>
      actions({
        id: task.id,
        anchor,
        edit: startTitle,
        canSelect: canSelect && !task.completed,
        selected: next,
      }),
    [actions, canSelect, next, startTitle, task.completed, task.id],
  );
  const toggleChildren = useCallback(() => setExpanded((open) => !open), []);
  const cardStyle = useMemo(
    () => [styles.todoCard, editing && styles.todoEditing, next && styles.nextRow],
    [editing, next, styles],
  );
  return (
    <View style={cardStyle} testID={"projets-task-" + task.id}>
      <View style={styles.todoLine}>
        {draft ? (
          <View style={styles.checkTarget} />
        ) : (
          <ToggleDone
            title={task.title}
            done={task.completed}
            doing={doing}
            reset={reset}
            onChange={toggle}
            styles={styles}
          />
        )}
        <TaskTitle
          id={task.id}
          title={task.title}
          done={task.completed}
          styles={styles}
          editing={titleEditing}
          focused={focus === task.id}
          activeCard={editing}
          focusField={startTitle}
          closeCard={closeCard}
          draft={Boolean(draft)}
          start={startTitle}
          stop={stopTitle}
          save={rename}
          empty={deleteEmpty}
          enter={addSibling}
          createBelow={addSibling}
          down={focusNotes}
        />
      </View>
      {draft ? null : (
        <TaskTools title={task.title} muted={muted} open={openActions} styles={styles} />
      )}
      {editing ? (
        <TaskNotes
          value={task.description}
          focused={focus === notesField}
          focus={focusNotes}
          close={closeCard}
          up={startTitle}
          down={focusFirstChild}
          createBelow={addSibling}
          save={saveNotes}
          styles={styles}
        />
      ) : null}
      {editing && (!draft || draft.saved) && children.length === 0 ? (
        <AddSubtaskButton add={addChild} styles={styles} />
      ) : null}
      {children.length ? (
        <View style={styles.subtasks}>
          {(expanded || editing ? children : children.slice(0, 3)).map((child, index) => (
            <SubtaskRow
              key={child.id}
              child={child}
              taskId={task.id}
              editing={focus === child.id}
              draft={childDraft?.id === child.id ? childDraft : undefined}
              write={write}
              index={index}
              focusChild={focusChild}
              start={setFocus}
              stop={stopChild}
              createBelow={addSibling}
              closeCard={closeCard}
              styles={styles}
            />
          ))}
          {!editing && children.length > 3 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={"Sous-tâches de " + task.title}
              aria-expanded={expanded}
              onPress={toggleChildren}
              style={styles.subCount}
            >
              <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={muted} />
              <Text style={styles.small}>
                {expanded ? "Réduire" : "Afficher les " + children.length + " sous-tâches"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function AddSubtaskButton({ add, styles }: { add(): void; styles: ProjectStyles }) {
  if (Platform.OS === "web") {
    return (
      <button type="button" onMouseDown={keepEditorFocused} onClick={add} style={addSubtaskStyle}>
        <Text style={styles.small}>Ajouter une sous-tâche</Text>
      </button>
    );
  }
  return (
    <Pressable accessibilityRole="button" onPressIn={add} style={styles.inlineChildAdd}>
      <Text style={styles.small}>Ajouter une sous-tâche</Text>
    </Pressable>
  );
}

function keepEditorFocused(event: React.MouseEvent) {
  event.preventDefault();
}

const addSubtaskStyle = {
  background: "none",
  border: 0,
  cursor: "pointer",
  padding: "4px 0 0 26px",
  fontStyle: "italic",
  textAlign: "left",
} as const;

function cycleTaskStatus(done: boolean, doing: boolean) {
  if (done) return "todo" as const;
  return doing ? ("done" as const) : ("doing" as const);
}

export function TaskControlStyles() {
  if (Platform.OS !== "web") return null;
  return (
    <style>{`
    @media (hover: hover) and (pointer: fine) {
      [data-testid^="projets-task-"] .projets-task-menu-trigger { opacity: 0; }
      [data-testid^="projets-task-"]:hover .projets-task-menu-trigger,
      [data-testid^="projets-task-"]:focus-within .projets-task-menu-trigger,
      [data-testid^="projets-task-"] .projets-task-menu-trigger[aria-expanded="true"] { opacity: 1; }
    }
    [data-testid^="projets-task-"] [role="checkbox"] svg { stroke-width: 3; }
    [data-testid^="projets-task-"] textarea::placeholder { color: ${projectColors.placeholder}; }
    .projets-task-menu-trigger:hover { background: ${projectColors.accent} !important; }
    [data-testid^="projets-task-"]:hover { background-color: color-mix(in srgb, ${projectColors.accent} 40%, transparent); }
    .projets-task-menu-item:not(:disabled):is(:hover,:focus-visible) { background: ${projectColors.accent} !important; outline: none; }
    .projets-task-menu-item:disabled { opacity: .45; }
    [data-projets-sortable]:has(+ [data-projets-sortable]) { border-bottom: 1px solid ${projectColors.borderSubtle}; }
  `}</style>
  );
}

function TaskTools({
  title,
  muted,
  open,
  styles,
}: {
  title: string;
  muted: string;
  open(anchor?: HTMLButtonElement): void;
  styles: ProjectStyles;
}) {
  const click = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => open(event.currentTarget),
    [open],
  );
  const press = useCallback(() => open(), [open]);
  const label = "Actions de " + title;
  return (
    <View style={styles.todoTools}>
      {Platform.OS === "web" ? (
        <button
          type="button"
          className="projets-task-menu-trigger"
          data-no-dnd=""
          aria-label={label}
          aria-haspopup="menu"
          onClick={click}
          style={toolsStyle}
        >
          <Icon name="MoreHorizontal" color={muted} size={14} />
        </button>
      ) : (
        <TaskAction
          icon="MoreHorizontal"
          color={muted}
          label={label}
          onPress={press}
          styles={styles}
        />
      )}
    </View>
  );
}

const toolsStyle = {
  display: "grid",
  placeItems: "center",
  height: 24,
  width: 24,
  cursor: "pointer",
  padding: 0,
  border: 0,
  borderRadius: 4,
  background: "transparent",
  transition: "opacity 120ms ease",
} as const;

function SubtaskRow({
  child,
  taskId,
  write,
  index,
  focusChild,
  editing,
  draft,
  start,
  stop,
  closeCard,
  createBelow,
  styles,
}: {
  child: ProjectSubtask;
  taskId: string;
  write(change: Change): Promise<void>;
  index: number;
  focusChild(index: number, direction: -1 | 1): void;
  editing: boolean;
  draft?: TaskDraft;
  start(id: string): void;
  stop(id: string): void;
  closeCard(): void;
  createBelow(): void;
  styles: ProjectStyles;
}) {
  const toast = useToast();
  const move = useCallback(
    (direction: -1 | 1) => {
      void write({ operation: "subtask-move", taskId, subtaskId: child.id, direction }).catch(() =>
        toast.error("Déplacement non enregistré"),
      );
    },
    [child.id, taskId, toast, write],
  );
  const toggle = useCallback(
    () =>
      write({
        operation: "subtask-update",
        taskId,
        subtaskId: child.id,
        completed: !child.completed,
      }),
    [child.id, child.completed, taskId, write],
  );
  const rename = useCallback(
    async (title: string) => {
      if (draft && !draft.saved) {
        await write({ operation: "subtask-add", taskId, subtaskId: child.id, title });
        draft.saved = true;
        return;
      }
      await write({ operation: "subtask-update", taskId, subtaskId: child.id, title });
    },
    [child.id, draft, taskId, write],
  );
  const remove = useCallback(async () => {
    if (!draft || draft.saved)
      await write({ operation: "subtask-delete", taskId, subtaskId: child.id });
  }, [child.id, draft, taskId, write]);
  const open = useCallback(() => start(child.id), [child.id, start]);
  const close = useCallback(() => stop(child.id), [child.id, stop]);
  const up = useCallback(() => focusChild(index, -1), [focusChild, index]);
  const down = useCallback(() => focusChild(index, 1), [focusChild, index]);
  return (
    <View style={styles.subtaskLine}>
      {draft ? (
        <View style={styles.subtaskCheckTarget} />
      ) : (
        <ToggleDone
          title={child.title}
          done={child.completed}
          subtask
          onChange={toggle}
          styles={styles}
        />
      )}
      <TaskTitle
        id={child.id}
        subtask
        closeCard={closeCard}
        createBelow={createBelow}
        move={move}
        title={child.title}
        done={child.completed}
        editing={editing}
        draft={Boolean(draft)}
        styles={styles}
        start={open}
        stop={close}
        save={rename}
        empty={remove}
        up={up}
        down={down}
      />
    </View>
  );
}
