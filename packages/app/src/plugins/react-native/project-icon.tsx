import { useMemo } from "react";
import { ProjectIconView } from "@/components/project-icon-view";
import {
  getHostProjectId,
  getHostProjectPlacement,
  useHostProjects,
} from "@/projects/host-projects";
import { useProjectIcons } from "@/projects/icons";

export function PluginProjectIcon({
  serverId,
  projectId,
  size,
}: {
  serverId: string;
  projectId: string;
  size: number;
}) {
  const hosts = useMemo(() => [serverId], [serverId]);
  const projects = useHostProjects(hosts);
  const project = projects.find((candidate) => getHostProjectId(candidate, serverId) === projectId);
  const targets = useMemo(() => {
    const placement = project && getHostProjectPlacement(project, serverId);
    return placement ? [{ ...placement, projectViewKey: project.viewKey }] : [];
  }, [project, serverId]);
  const icons = useProjectIcons({ projects: targets });
  const textStyle = useMemo(
    () => ({ fontSize: Math.round(size * 0.6), fontWeight: "600" as const }),
    [size],
  );
  if (!project) return null;
  const icon = icons.get(project.viewKey);
  return (
    <ProjectIconView
      iconDataUri={icon?.dataUri ?? null}
      emoji={icon?.emoji}
      initial={project.projectName.trim().charAt(0).toUpperCase() || "?"}
      projectViewKey={project.viewKey}
      size={size}
      textStyle={textStyle}
    />
  );
}
