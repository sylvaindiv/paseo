import { useEffect, useState } from "react";
import type { PreviewOperation, PreviewResult } from "@getpaseo/protocol/messages";
import { getDesktopHost } from "@/desktop/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useBrowserStore } from "./store";
import type { ServicePreviewTarget } from "./store/state";

const expired = { kind: "error", code: "expired" } as const;
interface PreviewPartition {
  target: ServicePreviewTarget;
  partition: Promise<string>;
  isClosed(): boolean;
  close(): Promise<void>;
}
const partitions = new Map<string, PreviewPartition>();

function openPartition(browserId: string, target: ServicePreviewTarget): Promise<string> {
  const existing = partitions.get(browserId);
  if (existing?.target === target && !existing.isClosed()) return existing.partition;
  const bridge = getDesktopHost()?.browser?.servicePreview;
  if (!bridge) return Promise.reject(new Error("Preview bridge unavailable"));
  const previousClosed = existing?.close();
  const previewId = crypto.randomUUID();
  const open: PreviewOperation = {
    kind: "open",
    origin: target.origin,
    workspaceId: target.workspaceId,
  };
  let opening: Promise<PreviewResult> | null = null;
  let closed = false;

  const unsubscribe = bridge.onExchange(({ browserId: sourceId, id, operation }) => {
    if (sourceId !== browserId) return;
    void (async () => {
      const client = getHostRuntimeStore().getClient(target.serverId);
      if (closed || !client?.isConnected) return expired;
      if (client.getLastServerInfoMessage()?.features?.privateServicePreview !== true)
        return { kind: "error", code: "upgrade" } as const;
      const initial = await client.exchangeServicePreview(previewId, operation);
      if (
        initial.kind !== "error" ||
        initial.code !== "expired" ||
        !client.isConnected ||
        closed ||
        operation.kind === "ws-close" ||
        operation.kind === "ws-read" ||
        operation.kind === "ws-send"
      )
        return initial;
      opening ??= client.exchangeServicePreview(previewId, open).finally(() => {
        opening = null;
      });
      const opened = await opening;
      if (opened.kind !== "ok") return opened;
      if (closed) {
        void client.exchangeServicePreview(previewId, { kind: "close" }).catch(() => undefined);
        return expired;
      }
      return client.exchangeServicePreview(previewId, operation);
    })().then(
      (result) => bridge.reply(id, result),
      (error: unknown) => {
        const denied = error instanceof Error && "code" in error && error.code === "access_denied";
        bridge.reply(id, denied ? { kind: "error", code: "denied" } : expired);
      },
    );
  });

  const unsubscribeStore = useBrowserStore.subscribe((state) => {
    if (!state.browsersById[browserId]) void close();
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    unsubscribe();
    unsubscribeStore();
    void getHostRuntimeStore()
      .getClient(target.serverId)
      ?.exchangeServicePreview(previewId, { kind: "close" })
      .catch(() => undefined);
    // Wait for a possibly pending open before closing the IPC registration for this browser ID.
    closing = opened
      .then(
        () => bridge!.close(browserId),
        () => undefined,
      )
      .catch(() => undefined)
      .finally(() => {
        if (partitions.get(browserId)?.partition === partition) partitions.delete(browserId);
      });
    return closing;
  }
  const opened = Promise.resolve(previousClosed).then(() => {
    if (closed) throw new Error("Preview closed");
    return bridge.open(browserId, target.origin);
  });
  const partition = opened.catch((error: unknown) => {
    void close();
    throw error;
  });
  partitions.set(browserId, { target, partition, isClosed: () => closed, close });
  return partition;
}

export function useServicePreviewPartition(
  browserId: string,
  target: ServicePreviewTarget | undefined,
) {
  const [ready, setReady] = useState<{
    browserId: string;
    target: ServicePreviewTarget;
    partition: string;
  } | null>(null);
  useEffect(() => {
    if (!target) {
      void partitions.get(browserId)?.close();
      return;
    }
    let active = true;
    void openPartition(browserId, target).then(
      (partition) => {
        if (active) setReady({ browserId, target, partition });
        return undefined;
      },
      () => {
        if (active)
          useBrowserStore.getState().updateBrowser(browserId, {
            isLoading: false,
            lastError: "Impossible d’ouvrir l’aperçu.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [browserId, target]);
  return ready?.browserId === browserId && ready.target === target ? ready.partition : undefined;
}
