import type { AgentConfigApply } from "@getpaseo/protocol/messages";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { isWorkflowAgentProfile } from "../profile-visibility";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  materializeAgentProfile,
  reconcileMaterializedProfileMode,
  toAgentConfigApply,
  type MaterializedAgentProfile,
} from "./materialize-profile";
import { buildAgentProfileTags } from "./profile-summary";
import { useAgentProfiles } from "./use-agent-profiles";

function mergeProfileConfig(current: AgentConfigApply, next: AgentConfigApply): AgentConfigApply {
  return {
    ...current,
    ...next,
    ...(current.featureValues || next.featureValues
      ? {
          featureValues: { ...current.featureValues, ...next.featureValues },
        }
      : {}),
  };
}

function pendingProfileConfig(queue: {
  pending: { config: AgentConfigApply } | null;
}): AgentConfigApply {
  return queue.pending?.config ?? {};
}

/** The draft composer owns profile application as one state transition. */
export interface DraftAgentProfileControls {
  applyProfile: (profile: MaterializedAgentProfile) => void;
}

export type AgentProfileApplyTarget =
  | { kind: "agent"; agentId: string; availableModeIds: readonly string[] | null }
  | { kind: "draft"; controls: DraftAgentProfileControls };

/** Everything the model picker renders for one profile. It never sees the profile itself. */
export interface AgentProfilePickerRow {
  id: string;
  provider: string;
  /** Empty when the profile names no model. */
  modelId: string;
  /** Icon registry key and identity colour; either may be empty for the default glyph. */
  icon: string;
  color: string;
  name: string;
  /** "Claude Code · Opus 5 · Plan · Think hard" */
  summary: string;
}

export interface AgentProfilePicker {
  rows: AgentProfilePickerRow[];
  applyProfile: (profileId: string) => void;
  applyNextProfile: () => boolean;
  pendingConfig: AgentConfigApply | null;
}

export interface UseAgentProfilePickerInput {
  serverId: string | null;
  /**
   * Providers this composer can actually run; pass a stable reference. A profile
   * naming anything else is hidden rather than shown as a row that cannot do
   * what it says — a live agent is one provider's process and cannot switch, and
   * the draft form ignores a provider the host does not offer.
   */
  availableProviders: readonly string[];
  target: AgentProfileApplyTarget;
}

/**
 * The agent-profiles section of the model picker: the rows to draw, and what
 * pressing one does. A supported host returns an empty row list when there is
 * nothing applicable so the picker can retain its settings shortcut without
 * pinning an empty section. Unsupported or still-loading hosts return `null`.
 */
export function useAgentProfilePicker(
  input: UseAgentProfilePickerInput,
): AgentProfilePicker | null {
  const { serverId, availableProviders, target } = input;
  const { t } = useTranslation();
  const { profiles, isSupported } = useAgentProfiles(serverId);
  // Profiles are host config, so their labels read from the host-wide catalog
  // rather than a workspace's. That is also the key the settings section uses,
  // so every composer on a host shares one query instead of adding its own.
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const { updatePreferences } = useFormPreferences();
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const toast = useToast();
  const lastAppliedProfileIdRef = useRef<string | null>(null);
  const agentId = target.kind === "agent" ? target.agentId : null;
  const queue = useMemo(
    () => ({
      serverId,
      agentId,
      running: false,
      pending: null as { profile: MaterializedAgentProfile; config: AgentConfigApply } | null,
      desired: {} as AgentConfigApply,
    }),
    [serverId, agentId],
  );
  const [pending, setPending] = useState<{ owner: typeof queue; config: AgentConfigApply } | null>(
    null,
  );
  const pendingConfig = pending?.owner === queue ? pending.config : null;

  const applicableProfiles = useMemo(() => {
    if (!isSupported || !profiles) {
      return [];
    }
    const available = new Set(availableProviders);
    return profiles.filter(
      (profile) => !isWorkflowAgentProfile(profile) && available.has(profile.provider),
    );
  }, [availableProviders, isSupported, profiles]);

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );

  const rows = useMemo<AgentProfilePickerRow[]>(
    () =>
      applicableProfiles.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        modelId: profile.model?.trim() ?? "",
        icon: profile.icon ?? "",
        color: profile.color ?? "",
        name: profile.name,
        summary: buildAgentProfileTags({ profile, entries, formatFeatureCount })
          .map((tag) => tag.label)
          .join(" · "),
      })),
    [applicableProfiles, entries, formatFeatureCount],
  );

  const persistSelection = useCallback(
    (resolved: MaterializedAgentProfile) => {
      void updatePreferences((current) =>
        mergeCreateAgentSelectionPreferences({
          preferences: current,
          provider: resolved.provider,
          modelId: resolved.modelId,
          modeId: resolved.modeId || undefined,
          thinkingOptionId: resolved.thinkingOptionId,
          ...(Object.keys(resolved.featureValues).length > 0
            ? { featureValues: resolved.featureValues }
            : {}),
        }),
      ).catch((error) => {
        console.warn("[useAgentProfilePicker] persist profile selection failed", error);
      });
    },
    [updatePreferences],
  );

  const applyProfile = useCallback(
    (profileId: string) => {
      const profile = applicableProfiles.find((entry) => entry.id === profileId);
      if (!profile) {
        return;
      }
      const resolved = materializeAgentProfile(profile);

      if (target.kind === "draft") {
        target.controls.applyProfile(resolved);
        lastAppliedProfileIdRef.current = profileId;
        return;
      }

      const reconciled = reconcileMaterializedProfileMode(resolved, target.availableModeIds);
      if (!reconciled) {
        return;
      }
      if (!client) return;
      lastAppliedProfileIdRef.current = profileId;
      const next = toAgentConfigApply(reconciled);
      queue.desired = mergeProfileConfig(queue.desired, next);
      // Only coalesce requests that have not started. Omitted fields must not
      // replay an in-flight setter if that setter fails.
      queue.pending = {
        profile: reconciled,
        config: mergeProfileConfig(queue.pending?.config ?? {}, next),
      };
      setPending({ owner: queue, config: queue.desired });
      if (queue.running) return;
      queue.running = true;
      void (async () => {
        try {
          while (queue.pending) {
            const request = queue.pending;
            queue.pending = null;
            try {
              const notice = await client.applyAgentConfig(target.agentId, request.config);
              persistSelection({
                ...request.profile,
                modelId: request.config.modelId ?? "",
                modeId: request.config.modeId ?? "",
                thinkingOptionId: request.config.thinkingOptionId ?? "",
                featureValues: request.config.featureValues ?? {},
              });
              showProviderNoticeToast(toast, notice);
            } catch (error) {
              console.warn("[useAgentProfilePicker] applyAgentConfig failed", error);
              toast.error(toErrorMessage(error));
              queue.desired = pendingProfileConfig(queue);
              setPending((current) =>
                current?.owner === queue ? { owner: queue, config: queue.desired } : current,
              );
            }
          }
        } finally {
          queue.running = false;
          queue.desired = {};
          setPending((current) => (current?.owner === queue ? null : current));
        }
      })();
    },
    [applicableProfiles, client, persistSelection, queue, target, toast],
  );

  const applyNextProfile = useCallback(() => {
    if (applicableProfiles.length === 0) return false;
    if (target.kind === "agent" && (!client || target.availableModeIds === null)) return false;
    const currentIndex = applicableProfiles.findIndex(
      (profile) => profile.id === lastAppliedProfileIdRef.current,
    );
    applyProfile(applicableProfiles[(currentIndex + 1) % applicableProfiles.length].id);
    return true;
  }, [applicableProfiles, applyProfile, client, target]);

  return useMemo(
    () =>
      isSupported && profiles !== null
        ? { rows, applyProfile, applyNextProfile, pendingConfig }
        : null,
    [applyNextProfile, applyProfile, isSupported, profiles, rows, pendingConfig],
  );
}
