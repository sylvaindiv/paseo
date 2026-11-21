import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Platform, Pressable, StyleSheet, Text } from "react-native";
import type { ProjectStyles } from "./styles.js";

const web = Platform.OS === "web";

interface TitleProps {
  id: string;
  title: string;
  done?: boolean;
  editing: boolean;
  draft?: boolean;
  subtask?: boolean;
  focused?: boolean;
  activeCard?: boolean;
  focusField?(): void;
  closeCard?(): void;
  createBelow?(): void;
  move?(direction: -1 | 1): void;
  styles: ProjectStyles;
  start(): void;
  stop(): void;
  save(title: string): Promise<void>;
  empty?(): Promise<void> | void;
  enter?(): void;
  up?(): void;
  down?(): void;
}

export function TaskTitle(props: TitleProps) {
  const { id, title, done, editing, activeCard, subtask, start, styles } = props;
  const style = useMemo(
    () => [subtask ? styles.subtaskTitle : styles.inlineTitle, done && styles.doneTitle],
    [done, styles, subtask],
  );
  if (editing) return <EditingTitle {...props} />;
  if (done && !subtask) return <Text style={style}>{title}</Text>;
  return (
    <Pressable
      style={styles.titleField}
      accessibilityRole="button"
      accessibilityLabel={"Modifier " + title}
      testID={"projets-label-" + id}
      onPress={start}
    >
      <Text style={style} numberOfLines={activeCard || subtask ? undefined : 2}>
        {title || "Sans titre"}
      </Text>
    </Pressable>
  );
}

function EditingTitle({
  id,
  title,
  subtask,
  focused = true,
  focusField,
  closeCard,
  createBelow,
  move,
  styles,
  stop,
  save,
  empty,
  enter,
  up,
  down,
}: TitleProps) {
  const [value, setValue] = useState(title);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finished = useRef(false);
  const latest = useRef({ value, save });
  latest.current = { value, save };
  const queued = useRef({ value: title, pending: Promise.resolve(true) });
  const persist = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = undefined;
    const next = latest.current.value.trim();
    if (!next || queued.current.value === next) return queued.current.pending;
    const write = latest.current.save;
    async function send(previous: Promise<boolean>) {
      await previous;
      try {
        await write(next);
        return true;
      } catch {
        if (queued.current.value === next) queued.current.value = "";
        toast.error("Titre non enregistré");
        return false;
      }
    }
    const pending = send(queued.current.pending);
    queued.current = { value: next, pending };
    return pending;
  }, [toast]);
  useEffect(
    () => () => {
      if (idle.current !== undefined) void persist();
    },
    [persist],
  );
  const change = useCallback(
    (text: string) => {
      if (finished.current) return;
      latest.current.value = text;
      setValue(text);
      clearTimeout(idle.current);
      idle.current = setTimeout(() => void persist(), 300);
    },
    [persist],
  );

  const finish = useCallback(
    async (next?: () => void, afterEmpty = false, exitCard = true) => {
      if (finished.current) return;
      finished.current = true;
      try {
        const hasTitle = Boolean(latest.current.value.trim());
        if (hasTitle) {
          if (!(await persist())) {
            finished.current = false;
            return;
          }
        } else {
          await queued.current.pending;
          await empty?.();
        }
        stop();
        if (next && (hasTitle || afterEmpty)) next();
        else if (exitCard) closeCard?.();
      } catch {
        toast.error("Modification non enregistrée");
        finished.current = false;
      }
    },
    [closeCard, empty, persist, stop, toast],
  );

  const blur = useCallback(() => void finish(), [finish]);
  const blurWeb = useCallback(
    (event: React.FocusEvent<HTMLTextAreaElement>) => {
      if (!isFocusWithinTask(event)) blur();
      else if (subtask) void finish(undefined, false, false);
      else void persist();
    },
    [blur, finish, persist, subtask],
  );
  const submit = useCallback(() => void finish(enter ?? down), [down, enter, finish]);
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      const { key, currentTarget } = event;
      if (
        runEditingShortcut(
          event,
          () => void finish(),
          createBelow && (() => void finish(createBelow)),
          move,
        )
      )
        return;
      if (key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      } else if (key === "ArrowDown" && down && (!subtask || cursorAtEdge(currentTarget, "end"))) {
        event.preventDefault();
        if (subtask) void finish(down);
        else {
          void persist();
          down();
        }
      } else if (key === "ArrowUp" && up && cursorAtEdge(currentTarget, "start")) {
        event.preventDefault();
        void finish(up, true);
      } else if ((key === "Backspace" || key === "Delete") && !value.trim() && empty) {
        event.preventDefault();
        void finish(up, true);
      }
    },
    [createBelow, down, empty, finish, move, persist, submit, subtask, up, value],
  );
  const changeWeb = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => change(event.target.value),
    [change],
  );

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!focused || !field || field.ownerDocument.activeElement === field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [focused]);
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    sizeTextarea(field);
  }, [value]);

  const editorStyle = useMemo(
    () => ({
      ...textareaStyle,
      color: StyleSheet.flatten(styles.editingTitle).color,
      borderBottomColor: StyleSheet.flatten(styles.editingTitle).borderColor,
      fontSize: subtask ? 13 : 15,
      lineHeight: subtask ? 1.25 : 1.5,
    }),
    [styles.editingTitle, subtask],
  );
  const newLabel = subtask ? "Nouvelle sous-tâche" : "Nouvelle tâche";
  const label = title ? "Modifier " + title : newLabel;
  const testId = "projets-title-" + id;
  if (web) {
    return (
      <textarea
        ref={textarea}
        rows={1}
        data-no-dnd=""
        data-testid={testId}
        aria-label={label}
        style={editorStyle}
        maxLength={1000}
        value={value}
        onChange={changeWeb}
        onFocus={focusField}
        onBlur={blurWeb}
        onKeyDown={keyDown}
      />
    );
  }
  return (
    <TextInput
      autoFocus={focused}
      accessibilityLabel={label}
      testID={testId}
      style={styles.editingTitle}
      maxLength={1000}
      value={value}
      onChangeText={change}
      onFocus={focusField}
      onBlur={blur}
      onSubmitEditing={submit}
    />
  );
}

function runEditingShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  exit: () => void,
  next?: () => void,
  move?: (direction: -1 | 1) => void,
) {
  const { key } = event;
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    exit();
  } else if (key === "n" && (event.metaKey || event.ctrlKey) && next) {
    event.preventDefault();
    next();
  } else if (event.altKey && move && (key === "ArrowUp" || key === "ArrowDown")) {
    event.preventDefault();
    move(key === "ArrowUp" ? -1 : 1);
  } else return false;
  return true;
}

const textareaStyle = {
  flex: 1,
  minWidth: 0,
  padding: "0 4px",
  minHeight: 23,
  overflow: "hidden",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontWeight: 500,
  border: 0,
  borderBottom: "1px dashed",
  outline: 0,
  resize: "none",
} as const;

const textMetrics = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderLeftWidth",
  "borderRightWidth",
  "boxSizing",
  "width",
] as const;

export function cursorAtEdge(field: HTMLTextAreaElement, edge: "start" | "end") {
  const reference = edge === "start" ? 0 : field.value.length;
  if (field.selectionStart === reference) return true;

  const mirror = field.ownerDocument.createElement("div");
  const marker = field.ownerDocument.createElement("span");
  const text = field.ownerDocument.createTextNode("");
  marker.textContent = "\u200b";
  const metrics = getComputedStyle(field);
  for (const property of textMetrics) mirror.style[property] = metrics[property];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.append(text, marker);
  field.ownerDocument.body.append(mirror);
  try {
    text.data = field.value.slice(0, field.selectionStart);
    const cursorLine = marker.offsetTop;
    text.data = field.value.slice(0, reference);
    return cursorLine === marker.offsetTop;
  } finally {
    mirror.remove();
  }
}

export function sizeTextarea(field: HTMLTextAreaElement) {
  field.style.height = "auto";
  field.style.height = field.scrollHeight + "px";
}

export function isFocusWithinTask(event: React.FocusEvent<HTMLElement>) {
  return (
    event.relatedTarget instanceof Node &&
    event.currentTarget.closest('[data-testid^="projets-task-"]')?.contains(event.relatedTarget) ===
      true
  );
}
