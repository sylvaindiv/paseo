import { useEffect, useState } from "react";
import type { PreviewOperation, PreviewResult } from "@getpaseo/protocol/messages";
import { getDesktopHost } from "@/desktop/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useBrowserStore } from "./store";
import type { ServicePreviewTarget } from "./store/state";

const expired = { kind: "error", code: "expired" } as const;
const partitions = new Map<string, Promise<string>>();

function openPartition(browserId: string, target: ServicePreviewTarget): Promise<string> {
  const existing = partitions.get(browserId);
  if (existing) return existing;
  const bridge = getDesktopHost()?.browser?.servicePreview;
  if (!bridge) return Promise.reject(new Error("Preview bridge unavailable"));
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
    if (!state.browsersById[browserId]) close();
  });
  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeStore();
    partitions.delete(browserId);
    void bridge?.close(browserId).catch(() => undefined);
    void getHostRuntimeStore()
      .getClient(target.serverId)
      ?.exchangeServicePreview(previewId, { kind: "close" })
      .catch(() => undefined);
  }
  const partition = bridge.open(browserId, target.origin).catch((error: unknown) => {
    close();
    throw error;
  });
  partitions.set(browserId, partition);
  return partition;
}

export function useServicePreviewPartition(
  browserId: string,
  target: ServicePreviewTarget | undefined,
) {
  const [ready, setReady] = useState<{ browserId: string; partition: string } | null>(null);
  useEffect(() => {
    if (!target) return;
    let active = true;
    void openPartition(browserId, target).then(
      (partition) => {
        if (active) setReady({ browserId, partition });
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
  return ready?.browserId === browserId ? ready.partition : undefined;
}
