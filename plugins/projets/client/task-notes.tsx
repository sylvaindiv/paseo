import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Platform, StyleSheet, View } from "react-native";
import { cursorAtEdge, isFocusWithinTask, sizeTextarea } from "./task-title.js";
import type { ProjectStyles } from "./styles.js";

export function TaskNotes({
  value,
  focused,
  focus,
  close,
  up,
  down,
  createBelow,
  save,
  styles,
}: {
  value: string | null;
  focused: boolean;
  focus(): void;
  close(): void;
  up(): void;
  down(): void;
  createBelow(): void;
  save(value: string): Promise<void>;
  styles: ProjectStyles;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const field = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(value ?? "");
  const toast = useToast();
  const commit = useCallback(
    async (next?: () => void) => {
      if (draft !== saved.current) {
        const previous = saved.current;
        saved.current = draft;
        try {
          await save(draft);
        } catch {
          saved.current = previous;
          toast.error("Notes non enregistrées");
          return;
        }
      }
      next?.();
    },
    [draft, save, toast],
  );
  const blur = useCallback(() => void commit(close), [close, commit]);
  const blurWeb = useCallback(
    (event: FocusEvent<HTMLTextAreaElement>) =>
      void commit(isFocusWithinTask(event) ? undefined : close),
    [close, commit],
  );
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const { key, currentTarget } = event;
      if (event.nativeEvent.isComposing) return;
      const shortcut = key === "n" && (event.metaKey || event.ctrlKey);
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      let next: (() => void) | undefined;
      if (key === "Escape") next = close;
      else if (shortcut) next = createBelow;
      else if (plain && key === "ArrowUp" && cursorAtEdge(currentTarget, "start")) next = up;
      else if (plain && key === "ArrowDown" && cursorAtEdge(currentTarget, "end")) next = down;
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      void commit(next);
    },
    [close, commit, createBelow, down, up],
  );
  const change = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    [],
  );
  useLayoutEffect(() => {
    const input = field.current;
    if (!focused || !input || input.ownerDocument.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [focused]);
  useLayoutEffect(() => {
    if (field.current) sizeTextarea(field.current);
  }, [draft]);
  const style = useMemo(
    () => ({
      ...notesStyle,
      color: StyleSheet.flatten(styles.notesInput).color,
    }),
    [styles.notesInput],
  );
  return (
    <View style={styles.notes}>
      {Platform.OS === "web" ? (
        <textarea
          ref={field}
          data-no-dnd=""
          rows={1}
          style={style}
          aria-label="Notes"
          placeholder="Notes…"
          value={draft}
          onChange={change}
          onFocus={focus}
          onBlur={blurWeb}
          onKeyDown={keyDown}
        />
      ) : (
        <TextInput
          multiline
          autoFocus={focused}
          style={styles.notesInput}
          accessibilityLabel="Notes"
          placeholder="Notes…"
          value={draft}
          onChangeText={setDraft}
          onFocus={focus}
          onBlur={blur}
        />
      )}
    </View>
  );
}

const notesStyle = {
  background: "transparent",
  width: "100%",
  minHeight: 25,
  display: "block",
  font: "inherit",
  fontSize: 12,
  lineHeight: 1.33,
  border: 0,
  borderRadius: 4,
  outline: 0,
  padding: "6px 8px",
  overflow: "hidden",
  resize: "none",
  boxSizing: "border-box",
} as const;
