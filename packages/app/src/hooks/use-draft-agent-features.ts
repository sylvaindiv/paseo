import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentProvider, AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";
import { applyFeatureValues, resolveFeatureValues } from "./feature-preferences";

const EMPTY_FEATURE_VALUES: Record<string, unknown> = {};

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId"
>;

export function useDraftAgentFeatures(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialFeatureValues?: Record<string, unknown>;
  hasPermissionModes: boolean;
}) {
  const { t } = useTranslation();
  const { serverId, provider, cwd, modeId, modelId, thinkingOptionId, initialFeatureValues } =
    input;
  const normalizedProvider = provider ?? null;
  const [selection, setSelection] = useState(() => ({
    provider: normalizedProvider,
    values: initialFeatureValues ?? {},
  }));
  // Scope intent to its provider; a profile switches provider and values together.
  if (selection.provider !== normalizedProvider) {
    setSelection({
      provider: normalizedProvider,
      values: selection.provider === null ? selection.values : {},
    });
  }
  const localFeatureValues = useMemo(
    () =>
      selection.provider === null || selection.provider === normalizedProvider
        ? selection.values
        : EMPTY_FEATURE_VALUES,
    [selection, normalizedProvider],
  );
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const persistedFeatureValues = useMemo(
    () => (provider ? (preferences.providerPreferences?.[provider]?.featureValues ?? {}) : {}),
    [preferences.providerPreferences, provider],
  );

  const draftConfig = useMemo<DraftFeatureConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) {
      return null;
    }

    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }, [modeId, modelId, normalizedCwd, normalizedProvider, thinkingOptionId]);

  const queryClient = useQueryClient();
  const queryOptions = useMemo(
    () => ({
      queryKey: [
        "providerFeatures",
        serverId ?? null,
        normalizedProvider,
        normalizedCwd || null,
        modeId ?? null,
        modelId ?? null,
        thinkingOptionId ?? null,
      ],
      enabled: Boolean(serverId && client && isConnected && draftConfig),
      staleTime: 5 * 60 * 1000,
      retry: false,
      queryFn: async () => {
        if (!client || !draftConfig) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }
        const payload = await client.listProviderFeatures(draftConfig);
        if (payload.error) {
          throw new Error(payload.error);
        }
        return payload.features ?? [];
      },
    }),
    [
      serverId,
      normalizedProvider,
      normalizedCwd,
      modeId,
      modelId,
      thinkingOptionId,
      client,
      isConnected,
      draftConfig,
      t,
    ],
  );
  const featuresQuery = useQuery(queryOptions);
  const resolveForSubmit = useCallback(async () => {
    const available = await queryClient.fetchQuery(queryOptions);
    const values = resolveFeatureValues({
      features: available,
      hasPermissionModes: input.hasPermissionModes,
      persistedFeatureValues,
      localFeatureValues,
    });
    return Object.keys(values).length > 0 ? values : undefined;
  }, [
    queryClient,
    queryOptions,
    input.hasPermissionModes,
    persistedFeatureValues,
    localFeatureValues,
  ]);
  const availableFeaturesRaw = featuresQuery.data;
  const availableFeatures = useMemo(() => availableFeaturesRaw ?? [], [availableFeaturesRaw]);
  const featureValues = useMemo(
    () =>
      resolveFeatureValues({
        features: availableFeatures,
        hasPermissionModes: input.hasPermissionModes,
        persistedFeatureValues,
        localFeatureValues,
      }),
    [availableFeatures, localFeatureValues, persistedFeatureValues, input.hasPermissionModes],
  );

  const features = useMemo(() => {
    return applyFeatureValues(availableFeatures, featureValues);
  }, [availableFeatures, featureValues]);

  const effectiveFeatureValues = Object.keys(featureValues).length > 0 ? featureValues : undefined;
  const setFeatureValue = useCallback(
    (featureId: string, value: unknown) => {
      setSelection((current) => ({
        provider: normalizedProvider,
        values: {
          ...(current.provider === normalizedProvider ? current.values : {}),
          [featureId]: value,
        },
      }));
      if (!provider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: {
            featureValues: {
              [featureId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[useDraftAgentFeatures] persist feature preference failed", error);
      });
    },
    [normalizedProvider, provider, updatePreferences],
  );

  const applyProfileFeatureValues = useCallback(
    (values: Record<string, unknown>, targetProvider: string | null = normalizedProvider) => {
      setSelection({ provider: targetProvider, values });
    },
    [normalizedProvider],
  );

  return {
    features,
    featureValues: effectiveFeatureValues,
    isLoading: featuresQuery.isPending,
    error: featuresQuery.error,
    retry: featuresQuery.refetch,
    resolveForSubmit,
    setFeatureValue,
    applyProfileFeatureValues,
  };
}
