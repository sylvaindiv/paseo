import { getPaseoClient, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { Text } from "react-native";
import { captureSettings, captureProfile } from "../shared/task-capture.js";

export function CaptureSettings({ host }: PluginSurfaceProps) {
  const setting = useSettings(captureSettings);
  const profiles = useQuery({
    queryKey: ["projets", "capture-profiles", host.id],
    queryFn: async () => {
      const list = (await getPaseoClient(host.id).config.get()).config.agentProfiles ?? [];
      const choices = list.some((p) => p.id === captureProfile.id)
        ? list
        : [captureProfile, ...list];
      return choices
        .filter((p) => !/^workflow/i.test(p.name.trimStart()))
        .map((p) => ({ value: p.id, label: p.name }));
    },
  });
  const change = useCallback(
    (profileId: string) => {
      if (setting.status === "ready") void setting.save({ profileId }, setting.revision);
    },
    [setting],
  );
  return (
    <SettingsSection title="Ajout de tâches">
      <SettingsCard>
        {setting.status === "ready" && profiles.data ? (
          <SettingsSelect
            label="Profil par défaut"
            options={profiles.data}
            value={setting.values.profileId}
            onValueChange={change}
            disabled={setting.saving}
            error={setting.saveError}
          />
        ) : (
          <Text>
            {setting.status === "loading" || profiles.isLoading
              ? "Chargement…"
              : "Profils indisponibles."}
          </Text>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
