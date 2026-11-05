/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDraftAgentFeatures } from "./use-draft-agent-features";

import { resolveFeatureValues } from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });
});

it("defaults only supported auto accept to true and preserves explicit false and Plan", () => {
  const features = [
    { id: "auto_accept", label: "Auto Accept", type: "toggle" as const, value: false },
    { id: "plan_mode", label: "Plan", type: "toggle" as const, value: false },
  ];
  expect(
    resolveFeatureValues({
      features,
      persistedFeatureValues: {},
      localFeatureValues: { plan_mode: true },
    }),
  ).toEqual({ auto_accept: true, plan_mode: true });
  expect(
    resolveFeatureValues({
      features,
      persistedFeatureValues: { auto_accept: false },
      localFeatureValues: {},
    }),
  ).toEqual({ auto_accept: false });
  expect(
    resolveFeatureValues({
      features,
      persistedFeatureValues: {},
      localFeatureValues: {},
      hasPermissionModes: true,
    }),
  ).toEqual({});
});

const { listProviderFeatures } = vi.hoisted(() => ({ listProviderFeatures: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ listProviderFeatures }),
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("./use-form-preferences", () => ({
  useFormPreferences: () => ({ preferences: {}, updatePreferences: async () => {} }),
}));

it("keeps an applied profile's Plan value across a provider change and a delayed discovery", async () => {
  const plan = { id: "plan_mode", label: "Plan", type: "toggle", value: false };
  let finish!: (value: { features: (typeof plan)[] }) => void;
  listProviderFeatures.mockImplementation(({ provider }) =>
    provider === "claude"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ features: [plan] }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, rerender, unmount } = renderHook(
    ({ provider }) =>
      useDraftAgentFeatures({
        serverId: "host",
        provider,
        cwd: "/repo",
        modeId: "",
        modelId: "model",
        thinkingOptionId: "",
        hasPermissionModes: true,
      }),
    {
      initialProps: { provider: "codex" },
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() => {
    result.current.applyProfileFeatureValues({ plan_mode: true }, "claude");
    rerender({ provider: "claude" });
  });
  await waitFor(() =>
    expect(listProviderFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude" }),
    ),
  );
  await act(async () => finish({ features: [plan] }));
  await waitFor(() => expect(result.current.featureValues).toEqual({ plan_mode: true }));
  unmount();
  queryClient.clear();
});

it("waits for capabilities before submission, preserves initial Plan, and reuses the cache", async () => {
  let finish!: (value: {
    features: { id: string; label: string; type: string; value: boolean }[];
  }) => void;
  listProviderFeatures.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, rerender, unmount } = renderHook(
    ({ provider }: { provider: string | null }) =>
      useDraftAgentFeatures({
        serverId: "host",
        provider,
        cwd: "/repo",
        modeId: "",
        modelId: "model",
        thinkingOptionId: "",
        initialFeatureValues: { plan_mode: true },
        hasPermissionModes: true,
      }),
    {
      initialProps: { provider: null as string | null },
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  rerender({ provider: "codex" });
  await waitFor(() => expect(listProviderFeatures).toHaveBeenCalledTimes(1));
  let settled = false;
  const submitted = result.current.resolveForSubmit().then((value) => {
    settled = true;
    return value;
  });
  await act(async () => {});
  expect(settled).toBe(false);
  await act(async () =>
    finish({ features: [{ id: "plan_mode", label: "Plan", type: "toggle", value: false }] }),
  );
  expect(await submitted).toEqual({ plan_mode: true });
  expect(await result.current.resolveForSubmit()).toEqual({ plan_mode: true });
  expect(listProviderFeatures).toHaveBeenCalledTimes(1);
  act(() => result.current.setFeatureValue("plan_mode", false));
  expect(await result.current.resolveForSubmit()).toEqual({ plan_mode: false });
  unmount();
  queryClient.clear();
});

it("rejects failed discovery and allows submission to retry without inventing Plan support", async () => {
  listProviderFeatures
    .mockReset()
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({ features: [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, unmount } = renderHook(
    () =>
      useDraftAgentFeatures({
        serverId: "host",
        provider: "codex",
        cwd: "/repo",
        modeId: "",
        modelId: "model",
        thinkingOptionId: "",
        initialFeatureValues: { plan_mode: true },
        hasPermissionModes: true,
      }),
    {
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  const submitted = result.current.resolveForSubmit();
  await expect(submitted).rejects.toThrow("Unavailable");
  await act(async () => {
    expect(await result.current.resolveForSubmit()).toBeUndefined();
  });
  expect(result.current.features).toEqual([]);
  unmount();
  queryClient.clear();
});
