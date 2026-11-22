import { useCallback, useEffect, type ReactNode } from "react";
import { Modal, Platform } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { ProjectButton } from "./project-button.js";

const windows = new Map<string, Window>();

export function ProjectsWindowButton({ hostId, detached }: { hostId: string; detached: boolean }) {
  const toast = useToast();
  const open = useCallback(() => {
    if (Platform.OS !== "web") return;
    const existing = windows.get(hostId);
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("param.fenetre", "projets");
    const child = window.open(
      url.href,
      "paseo-projets-" + hostId,
      "popup,width=1160,height=800,resizable=yes",
    );
    if (child) {
      windows.set(hostId, child);
      child.focus();
    } else {
      toast.error("Autorisez l’ouverture de la fenêtre Projets.");
    }
  }, [hostId, toast]);
  if (Platform.OS !== "web" || detached) return null;
  return <ProjectButton onPress={open}>Ouvrir dans une fenêtre</ProjectButton>;
}

export function ProjectsWindow({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const previous = document.title;
    document.title = "Projets";
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <Modal visible animationType="none">
      {children}
    </Modal>
  );
}
