/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- Local form events. */
import {
  getPaseoClient,
  useRpc,
  type PluginHostProps,
  type PluginDesktopCapture,
  type PluginDesktopCaptureFields,
} from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { captureReply, captureSession } from "../shared/task-capture.js";
import { captureContext, captureDrafts } from "./capture-tasks.js";
import { useSequence } from "./use-sequence.js";
import type { Sequence, SequenceRequest } from "../shared/sequence.js";
import { encodeImage } from "./folder-dispatch.js";

export interface Line {
  id: string;
  kind: "you" | "answer";
  text: string;
}
function errorMessage(cause: unknown) {
  if (!(cause instanceof Error)) return "Envoi impossible.";
  if (cause instanceof SyntaxError || cause.name === "ZodError")
    return "Réponse illisible. Réessaie.";
  return cause.message;
}
export const captureStyles = `
.taskCapture{position:fixed;inset:0 0 0 auto;margin:0;padding:0;width:min(410px,100vw);height:100dvh;max-height:100dvh;max-width:100vw;box-sizing:border-box;border:0;border-left:1px solid #dcdcd7;background:#fafaf9;color:#363631;font:14px/1.45 system-ui;box-shadow:-5px 0 28px #0001}
.desktopTaskCapture{inset:0;width:100vw;border-left:0}
.taskCapture .captureImages{display:flex;gap:8px;min-height:0}
.taskCapture .captureImages img{max-width:100%;min-width:0;max-height:220px;object-fit:contain}
.taskCapture::backdrop{background:#25252136}
.taskCapture[open]{display:flex;flex-direction:column}
.taskCapture header,.taskCapture form,.taskCapture .target{padding:14px 18px}
.taskCapture header{border-bottom:1px solid #e4e4df;display:flex;align-items:center;justify-content:space-between}
.taskCapture h2{margin:0;font-size:17px;font-weight:620}
.taskCapture button,.taskCapture select,.taskCapture textarea{font:inherit;color:inherit}
.taskCapture button,.taskCapture select{cursor:pointer}
.taskCapture header button{border:0;background:none;font-size:21px}
.taskCapture .target{display:flex;gap:12px;align-items:center;font-size:13px}
.taskCapture select{flex:1;min-width:0;border:1px solid #dcdcd7;border-radius:5px;background:#fff;padding:6px}
.taskCapture .history{flex:1;overflow:auto;padding:0 18px}
.taskCapture .history p{white-space:pre-wrap;overflow-wrap:anywhere;padding:9px 12px;margin:8px 0;border-radius:7px}
.taskCapture .you{margin-left:20px!important;background:#e9eee9}
.taskCapture .answer{background:white}.taskCapture .status{color:#66645f}
.taskCapture form{border-top:1px solid #deded9;background:white}
.taskCapture textarea{width:100%;box-sizing:border-box;border:0;resize:vertical;min-height:65px;padding:6px}
.taskCapture .actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
.taskCapture .send{border:0;border-radius:5px;padding:7px 13px;background:#3d5044;color:white}
.taskCapture .send:disabled{opacity:.5}
.taskCapture .attach{font-size:13px;cursor:pointer}.taskCapture .attach input{width:1px;opacity:0}
.taskCapture .files{font-size:12px;overflow-wrap:anywhere}
`;
// oxlint-disable-next-line complexity -- Desktop capture and the sidebar share the same form.
export function TaskCapture({
  hostId,
  close,
  capture,
}: {
  hostId: PluginHostProps["host"]["id"];
  close(): void;
  capture?: PluginDesktopCapture;
}) {
  const rpc = useRpc(captureSession);
  const call = useRef(rpc);
  call.current = rpc;
  const id = useRef(crypto.randomUUID());
  const started = useRef(false);
  const alive = useRef(false);
  const locked = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const { query, rpc: sequenceRpc } = useSequence(hostId);
  const snapshot = useRef<Sequence | undefined>(undefined);
  const pending = useRef<Extract<SequenceRequest, { action: "capture" }> | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  const [recordedSummary, setRecorded] = useState<string>();
  const captureId = capture?.id;
  const receipt = useQuery({
    queryKey: ["projets", "sequence-capture", hostId, captureId],
    queryFn: () => (captureId ? sequenceRpc({ action: "capture", id: captureId }) : null),
    enabled: Boolean(captureId),
    retry: false,
  });
  const recorded = recordedSummary ?? receipt.data?.receipt?.summary;
  const sequence = snapshot.current ?? query.data;
  const projects = sequence?.projects ?? [];
  const [manual, setManual] = useState<PluginDesktopCaptureFields>({
    project: "",
    text: "",
    files: [],
  });
  const { project, text, files } = capture?.fields ?? manual;
  function update(changes: Partial<PluginDesktopCaptureFields>) {
    snapshot.current ??= query.data;
    if (capture) capture.update(changes);
    else setManual((current) => ({ ...current, ...changes }));
  }
  const library = useRef<File[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const node = dialog.current;
    node?.showModal();
    node?.querySelector("textarea")?.focus();
    const sessionId = id.current;
    const archive = () => {
      alive.current = false;
      if (started.current) void call.current({ id: sessionId, action: "close" }).catch(() => {});
    };
    const timer = setInterval(() => {
      if (started.current) void call.current({ id: sessionId, action: "keep" }).catch(() => {});
    }, 25_000);
    window.addEventListener("pagehide", archive);
    return () => {
      window.removeEventListener("pagehide", archive);
      clearInterval(timer);
      archive();
      node?.close();
    };
  }, []);
  useEffect(() => {
    history.current?.scrollTo(0, history.current.scrollHeight);
  }, [lines, busy]);
  async function readReply(input: string, attachments: Awaited<ReturnType<typeof encodeImage>>[]) {
    const agent = getPaseoClient(hostId).agents.ref(id.current);
    let result = await agent.run(input, { images: attachments, timeoutMs: 60_000 });
    while (alive.current && result.status === "timeout") result = await agent.waitForFinish(60_000);
    if (!alive.current) return null;
    if (result.status !== "idle" || !result.lastMessage)
      throw new Error("L’agent n’a pas pu répondre.");
    return captureReply.parse(
      JSON.parse(
        result.lastMessage.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ""),
      ),
    );
  }
  async function ensureSession() {
    if (started.current) return;
    started.current = true;
    try {
      const { ok } = await rpc({ id: id.current, action: "open" });
      if (!ok) throw new Error("Projets indisponible. Réessaie.");
    } catch (cause) {
      started.current = false;
      throw cause;
    }
  }
  async function commit(request: Extract<SequenceRequest, { action: "capture" }>) {
    const result = await sequenceRpc(request);
    if (result.stale) {
      pending.current = undefined;
      setRetrying(false);
      const fresh = await query.refetch();
      update({ project: "" });
      snapshot.current = fresh.data;
      throw new Error(result.error);
    }
    if (!result.receipt) throw new Error(result.error ?? "Enregistrement à confirmer. Réessaie.");
    const { summary } = result.receipt;
    pending.current = undefined;
    snapshot.current = undefined;
    setRetrying(false);
    void query.refetch();
    if (capture) setRecorded(summary);
    else {
      update({ text: "", files: [] });
      snapshot.current = undefined;
      setLines((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: "answer", text: "Enregistré\n" + summary },
      ]);
    }
  }
  async function interpret(source: Sequence, selected: number | null, message: string) {
    const attachments = await Promise.all(files.map(encodeImage));
    if (!alive.current) return;
    await ensureSession();
    if (!alive.current) return;
    const offset = capture ? 0 : library.current.length;
    if (!capture) library.current.push(...files);
    const input = JSON.stringify({
      projetChoisi: selected,
      tableau: captureContext(source),
      message,
      observationsEcran: capture && { ...capture.context, texte: capture.ocr.slice(0, 32000) },
      imagesJointes: files.map((f, i) => ({ index: offset + i, nom: f.name })),
    });
    setLines((l) => [
      ...l,
      {
        id: crypto.randomUUID(),
        kind: "you",
        text: [message, ...files.map((f) => f.name)].filter(Boolean).join("\n"),
      },
    ]);
    const reply = await readReply(input, attachments);
    if (!reply) return;
    if (!reply.tasks.length) {
      const response = capture && selected === null ? "Quel projet ?" : reply.message;
      setLines((l) => [...l, { id: crypto.randomUUID(), kind: "answer", text: response }]);
      return;
    }
    const originals = capture ? files : library.current;
    const drafts = captureDrafts(
      source,
      reply,
      selected,
      capture ? files.map((_, i) => i) : undefined,
    );
    const indices = [...new Set(drafts.flatMap((draft) => draft.images))];
    const images = await Promise.all(
      indices.map(async (index) => {
        const file = originals[index];
        if (!file) throw new Error("Image introuvable.");
        return (await encodeImage(file)).data;
      }),
    );
    if (!alive.current) return;
    pending.current = {
      action: "capture",
      id: capture?.id ?? crypto.randomUUID(),
      tasks: drafts.map(
        ({ project: target, section, existing, title, note, subtasks, images: attachmentIds }) => ({
          project: target,
          section,
          existing,
          title,
          note,
          subtasks,
          images: attachmentIds.map((index) => indices.indexOf(index)),
        }),
      ),
      images,
    };
    setRetrying(true);
    await commit(pending.current);
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (
      recorded ||
      locked.current ||
      !sequence ||
      (!pending.current && !text.trim() && !files.length)
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    const message = text.trim();
    const projectIndex = sequence.projects.findIndex((row) => row.id === project);
    const selected = project ? projectIndex : null;
    try {
      if (pending.current) {
        await commit(pending.current);
        return;
      }
      if (capture) {
        const result = await sequenceRpc({ action: "capture", id: capture.id });
        if (result.receipt) {
          setRecorded(result.receipt.summary);
          return;
        }
        if (result.error) throw new Error(result.error);
      }
      if (selected === -1) {
        update({ project: "" });
        throw new Error("Le projet a changé. Choisis la destination.");
      }
      await interpret(sequence, selected, message);
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function attach(newFiles: FileList) {
    const incoming = Array.from(newFiles).filter((file) => file.type.startsWith("image/"));
    update({ files: [...files, ...incoming] });
  }
  const pendingCapture = Boolean(capture && busy);
  return createPortal(
    <dialog
      className={capture ? "taskCapture desktopTaskCapture" : "taskCapture"}
      ref={dialog}
      aria-labelledby="task-capture-heading"
      onCancel={(e) => {
        e.preventDefault();
        if (!capture || !locked.current) close();
      }}
      onClick={(e) => {
        if (!capture && e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right) close();
        }
      }}
    >
      <style>{captureStyles}</style>
      <header>
        <h2 id="task-capture-heading">Ajouter des tâches</h2>
        <button
          type="button"
          aria-label="Fermer la conversation"
          disabled={pendingCapture}
          onClick={close}
        >
          ×
        </button>
      </header>
      {recorded ? null : (
        <label className="target">
          Projet
          <select
            value={project}
            disabled={busy || retrying}
            onChange={(e) => update({ project: e.target.value })}
          >
            <option value="">Préciser dans le message</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="history" ref={history} role="log">
        {capture && <CapturePreview capture={capture} />}
        {recorded ? (
          <p className="answer">{"Enregistré\n" + recorded}</p>
        ) : (
          <CaptureConversation lines={lines} busy={busy} warning={capture?.warning} />
        )}
      </div>
      {recorded ? null : (
        <form onSubmit={send}>
          {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
          <textarea
            aria-label="Message"
            placeholder="Qu’y a-t-il à faire ?"
            value={text}
            disabled={busy || retrying}
            onChange={(e) => update({ text: e.target.value })}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (!capture && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {files.length > 0 && <p className="files">{files.map((f) => f.name).join(" · ")}</p>}
          <div className="actions">
            <label className="attach">
              ＋ Images
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={busy || retrying}
                onChange={(e) => {
                  if (e.target.files) attach(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              className="send"
              disabled={
                busy ||
                !sequence ||
                (!retrying && (!query.data || query.isError || (!text.trim() && !files.length)))
              }
              type="submit"
            >
              {retrying ? "Réessayer" : "Envoyer"}
            </button>
          </div>
        </form>
      )}
    </dialog>,
    document.body,
  );
}

function CapturePreview({ capture }: { capture: PluginDesktopCapture }) {
  const { files } = capture.fields;
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    if (capture.preview) return;
    const next = files.map((file) => URL.createObjectURL(file));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files, capture.preview]);
  return (
    capture.preview ?? (
      <div className="captureImages">
        {urls.map((url, index) => (
          <img key={url} src={url} alt={files[index]?.name ?? "Image"} />
        ))}
      </div>
    )
  );
}

export function CaptureConversation({
  lines,
  busy,
  warning,
}: {
  lines: Line[];
  busy: boolean;
  warning?: string;
}) {
  return (
    <>
      {warning && <p className="status">{warning}</p>}
      {lines.map((line) => (
        <p key={line.id} className={line.kind}>
          {line.text}
        </p>
      ))}
      {busy && <p className="status">En cours…</p>}
    </>
  );
}
