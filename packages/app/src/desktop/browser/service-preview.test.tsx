// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useServicePreviewPartition } from "./service-preview.electron";
import type { ServicePreviewTarget } from "./store/state";

const bridge = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  onExchange: vi.fn(() => () => undefined),
}));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ browser: { servicePreview: bridge } }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => null }),
}));
vi.mock("./store", () => ({ useBrowserStore: { subscribe: () => () => undefined } }));

it("waits for the previous guest proxy to close before changing origin in the same tab", async () => {
  let finishClose!: () => void;
  bridge.open.mockResolvedValueOnce("first-partition").mockResolvedValueOnce("second-partition");
  bridge.close
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const initial = { serverId: "mini", workspaceId: "work", origin: "http://localhost:54566" };
  const { result, rerender } = renderHook(
    ({ target }) => useServicePreviewPartition("same-tab", target),
    { initialProps: { target: undefined as ServicePreviewTarget | undefined } },
  );
  expect(result.current).toBeUndefined();
  rerender({ target: initial });
  await waitFor(() => expect(result.current).toBe("first-partition"));

  rerender({ target: { ...initial, origin: "http://localhost:5173" } });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(bridge.close).toHaveBeenCalledWith("same-tab"));
  expect(bridge.open).toHaveBeenCalledTimes(1);

  finishClose();
  await waitFor(() => expect(result.current).toBe("second-partition"));
  expect(bridge.open).toHaveBeenLastCalledWith("same-tab", "http://localhost:5173");

  rerender({ target: undefined });
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(bridge.close).toHaveBeenCalledTimes(2));
});
