import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import {
  exchangeThings,
  waitThings,
  chooseThings,
  relinkThings,
  diffRows,
  type Conflict,
} from "../shared/things.js";
import { boardRows, updateBoard } from "./things-board.js";
import type { FolderStore } from "./folder-store.js";

export function ThingsConnection({
  store,
  hostId,
  silent = false,
}: {
  store: FolderStore;
  hostId: string;
  silent?: boolean;
}) {
  const exchange = useRpc(exchangeThings),
    wait = useRpc(waitThings),
    choose = useRpc(chooseThings);
  const relink = useRpc(relinkThings);
  const restore = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.dataset.id;
      if (id) void relink({ id });
    },
    [relink],
  );
  const [state, setState] = useState({
    message: "",
    revision: "",
    detached: [] as { id: string; title: string }[],
    conflicts: [] as Conflict[],
  });
  useEffect(() => {
    let closed = false,
      running = false,
      queued = false,
      revision = "",
      stopped = false;
    let waiting = false,
      retry: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      if (closed || stopped || !store.get().ready) return;
      queued = true;
      if (running) return;
      running = true;
      try {
        while (queued) {
          if (closed) break;
          queued = false;
          await navigator.locks.request("projets-things-" + hostId, async () => {
            if (closed) return;
            const { board: current, persisted } = await store.read();
            const sent = boardRows(current);
            const existing = !persisted ? await exchange({ edits: [] }) : null;
            const reply = existing?.rows.length
              ? existing
              : await exchange({ edits: diffRows(current.thingsBase ?? {}, sent) });
            if (closed) return;
            revision = reply.revision;
            setState({
              message: reply.message,
              revision,
              conflicts: reply.conflicts,
              detached: reply.detached,
            });
            if (!reply.enabled) {
              stopped = true;
              return;
            }
            const received = Object.fromEntries(reply.rows.map((row) => [row.id, row]));
            if (
              !current.thingsBase ||
              diffRows(current.thingsBase, received).length ||
              diffRows(sent, received).length
            ) {
              await store.write((latest) => updateBoard(latest, sent, reply.rows));
            }
          });
        }
        if (!closed && !stopped && !waiting) {
          waiting = true;
          const since = revision;
          void (async () => {
            try {
              for (;;) {
                if (closed || since !== revision) break;
                const next = await wait({ revision: since });
                if (next !== since) break;
              }
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 2500));
            } finally {
              waiting = false;
              if (!closed) void sync();
            }
          })();
        }
      } catch {
        if (!closed) {
          setState((s) => ({ ...s, message: "Connexion à Things interrompue." }));
          clearTimeout(retry);
          retry = setTimeout(() => void sync(), 3500);
        }
      } finally {
        running = false;
        if (queued && !closed && !stopped) void sync();
      }
    };
    const unsubscribe = store.subscribe(() => void sync());
    void sync();
    return () => {
      closed = true;
      clearTimeout(retry);
      unsubscribe();
    };
  }, [exchange, wait, hostId, store]);
  const resolve = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      const { id, field, choice } = e.currentTarget.dataset;
      if (id && field && (choice === "paseo" || choice === "things"))
        await choose({ id, field, revision: state.revision, choice });
    },
    [choose, state.revision],
  );
  if (silent || (!state.message && !state.conflicts.length && !state.detached.length)) return null;
  return (
    <div role="status">
      {state.message}
      {state.detached.map((p) => (
        <p key={p.id}>
          {p.title} · Projet délié{" "}
          <button data-id={p.id} type="button" onClick={restore}>
            Relier à Things
          </button>
        </p>
      ))}
      {state.conflicts.map((c) => (
        <p key={c.id + "-" + c.field}>
          {c.field.startsWith("match:") ? "Associer ces éléments ?" : "Choisir la version à garder"}{" "}
          <button
            type="button"
            data-id={c.id}
            data-field={c.field}
            data-choice="paseo"
            onClick={resolve}
          >
            {c.field.startsWith("match:") ? "Garder séparés" : "Paseo · " + c.paseo}
          </button>{" "}
          <button
            type="button"
            data-id={c.id}
            data-field={c.field}
            data-choice="things"
            onClick={resolve}
          >
            {c.field.startsWith("match:") ? "Associer · " + c.things : "Things · " + c.things}
          </button>
        </p>
      ))}
    </div>
  );
}
