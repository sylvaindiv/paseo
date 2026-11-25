/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- Local dialog interactions. */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { coachAction, coachSkills, type CoachSkill } from "../shared/coach.js";
import { CaptureConversation, captureStyles, type Line } from "./task-capture.js";

interface Props {
  hostId: string;
  web: boolean;
  colors: {
    foreground: string;
    foregroundMuted: string;
    surface0: string;
    surface1: string;
    accent: string;
  };
  close(): void;
}

const emptyLines: Line[] = [];
const choices = Object.entries(coachSkills) as [CoachSkill, string][];
const labels = {
  plan: "Valider le planning",
  reflection: "Enregistrer le bilan",
  season: "Enregistrer la saison",
};
const css = `
.taskCapture.coachPanel{background:var(--coach-background);color:var(--coach-text);border-color:var(--coach-muted)}
.coachPanel header,.coachPanel form{border-color:color-mix(in srgb,var(--coach-text) 17%,transparent)}
.coachPanel form,.coachPanel .answer,.coachPanel .you,.coachPanel textarea{background:var(--coach-surface);color:inherit}
.coachPanel .you{background:color-mix(in srgb,var(--coach-accent) 14%,var(--coach-surface))}
.coachPanel .status{color:var(--coach-muted)}
.coachPanel .skills,.coachPanel .coachDecision{display:flex;flex-wrap:wrap;gap:8px;padding:12px 18px}
.coachPanel .skills button,.coachPanel .coachSecondary{background:transparent;border:1px solid color-mix(in srgb,var(--coach-text) 25%,transparent);border-radius:6px;padding:4px 8px}
.coachPanel .skills button[aria-pressed=true]{border-color:var(--coach-accent);color:var(--coach-accent)}
.coachPanel .send{background:#0063cd}
.coachPanel .actions{justify-content:flex-end}
`;

type Action =
  | { action: "send"; text: string; skill?: CoachSkill }
  | { action: "confirm" | "reject"; id: string }
  | { action: "retry" };

// oxlint-disable-next-line complexity -- Shared form state and desktop layout.
export function CoachPanel({ hostId, web, colors, close }: Props) {
  const rpc = useRpc(coachAction);
  const cache = useQueryClient();
  const key = ["projets", "coach", hostId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => rpc({ action: "read" }),
    refetchInterval: (current) => (current.state.data?.busy ? 1000 : false),
    retry: false,
  });
  const state = query.data;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const nativeHistory = useRef<ScrollView>(null);
  const busy = sending || Boolean(state?.busy);
  const draft = state?.draft;
  const applying = draft?.kind === "plan" && draft.applying === true;
  const disabled = !state || busy;
  const notice = error || state?.error || (query.isError ? "Coach indisponible." : "");
  const decisions: { label: string; action: Action; primary?: boolean }[] = [];
  if (draft) {
    decisions.push({
      label: applying ? "Réessayer la validation" : labels[draft.kind],
      action: { action: "confirm", id: draft.id },
      primary: true,
    });
    if (!applying) decisions.push({ label: "Refuser", action: { action: "reject", id: draft.id } });
  }
  if (state?.canRetry) decisions.push({ label: "Réessayer", action: { action: "retry" } });
  const lines = state?.lines ?? emptyLines;
  const unavailable = disabled || applying;

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useEffect(() => {
    history.current?.scrollTo(0, history.current.scrollHeight);
    nativeHistory.current?.scrollToEnd({ animated: false });
  }, [state?.lines.length, busy]);

  async function act(action: Action) {
    if (disabled || locked.current || !state) return;
    locked.current = true;
    setSending(true);
    setError("");
    try {
      const result = await rpc(
        action.action === "send"
          ? {
              ...action,
              revision: state.revision,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : { ...action, revision: state.revision },
      );
      cache.setQueryData(key, result);
      if (
        action.action === "send" &&
        !action.skill &&
        result.lines
          .slice(state.lines.length)
          .some((line) => line.kind === "you" && line.text === action.text)
      ) {
        setText("");
      }
    } catch {
      setError("Connexion interrompue. Réessaie.");
      void query.refetch();
    } finally {
      locked.current = false;
      setSending(false);
    }
  }
  function send() {
    if (text.trim() && !applying) void act({ action: "send", text: text.trim() });
  }
  function enter(skill: CoachSkill) {
    void act({ action: "send", skill, text: coachSkills[skill] });
  }

  if (!web)
    return (
      <NativeCoach
        {...{
          colors,
          close,
          unavailable,
          disabled,
          busy,
          notice,
          lines,
          decisions,
          act,
          enter,
          nativeHistory,
          text,
          setText,
          send,
        }}
      />
    );

  return createPortal(
    <dialog
      className="taskCapture coachPanel"
      ref={dialog}
      aria-labelledby="coach-heading"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      style={
        {
          "--coach-background": colors.surface0,
          "--coach-surface": colors.surface1,
          "--coach-text": colors.foreground,
          "--coach-muted": colors.foregroundMuted,
          "--coach-accent": colors.accent,
        } as CSSProperties
      }
    >
      <style>{captureStyles + css}</style>
      <header>
        <h2 id="coach-heading">Coach</h2>
        <button type="button" onClick={close} aria-label="Fermer la conversation">
          ×
        </button>
      </header>
      <div className="skills" aria-label="Parcours">
        {choices.map(([skill, label]) => (
          <button
            key={skill}
            type="button"
            disabled={unavailable}
            aria-pressed={Boolean(state?.lines.length) && state?.skill === skill}
            onClick={() => enter(skill)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="history" role="log" ref={history}>
        <CaptureConversation lines={lines} busy={busy || query.isLoading} />
      </div>
      {decisions.length > 0 && (
        <div className="coachDecision">
          {decisions.map(({ label, primary, action }) => (
            <button
              key={label}
              className={primary ? "send" : "coachSecondary"}
              disabled={disabled}
              type="button"
              onClick={() => void act(action)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {notice && <p role="alert">{notice}</p>}
        <textarea
          aria-label="Message"
          placeholder="Ton message"
          value={text}
          maxLength={3500}
          disabled={unavailable}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="actions">
          <button className="send" type="submit" disabled={unavailable || !text.trim()}>
            Envoyer
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

function NativeCoach({
  colors,
  close,
  unavailable,
  disabled,
  busy,
  notice,
  lines,
  decisions,
  act,
  enter,
  nativeHistory,
  text,
  setText,
  send,
}: Pick<Props, "colors" | "close"> & {
  unavailable: boolean;
  disabled: boolean;
  busy: boolean;
  notice: string;
  lines: Line[];
  decisions: { label: string; action: Action }[];
  act(action: Action): Promise<void>;
  enter(skill: CoachSkill): void;
  nativeHistory: React.RefObject<ScrollView | null>;
  text: string;
  setText(text: string): void;
  send(): void;
}) {
  const button = (label: string, onPress: () => void, off = disabled) => (
    <Pressable key={label} accessibilityRole="button" disabled={off} onPress={onPress}>
      <Text style={{ color: off ? colors.foregroundMuted : colors.accent, padding: 8 }}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <Modal visible onRequestClose={close}>
      <View style={{ flex: 1, padding: 16, backgroundColor: colors.surface0 }}>
        <View
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
        >
          <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>Coach</Text>
          {button("Fermer", close, false)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {choices.map(([skill, label]) => button(label, () => enter(skill), unavailable))}
        </View>
        <ScrollView ref={nativeHistory} style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          {lines.map((line) => (
            <Text
              key={line.id}
              style={{
                padding: 10,
                margin: 4,
                color: colors.foreground,
                backgroundColor: colors.surface1,
                marginLeft: line.kind === "you" ? 24 : 4,
              }}
            >
              {line.text}
            </Text>
          ))}
          <Text style={{ color: colors.foregroundMuted }}>{busy ? "En cours…" : notice}</Text>
        </ScrollView>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {decisions.map(({ label, action }) => button(label, () => void act(action)))}
        </View>
        <TextInput
          accessibilityLabel="Message"
          placeholder="Ton message"
          placeholderTextColor={colors.foregroundMuted}
          multiline
          maxLength={3500}
          value={text}
          editable={!unavailable}
          onChangeText={setText}
          style={{ padding: 10, color: colors.foreground, backgroundColor: colors.surface1 }}
        />
        {button("Envoyer", send, unavailable || !text.trim())}
      </View>
    </Modal>
  );
}
