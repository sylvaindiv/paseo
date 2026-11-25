import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

const windows = new Map<string, Window>();
export function BoardWindowButton({ hostId }: { hostId: string }) {
  const toast = useToast();
  const open = useCallback(() => {
    const previous = windows.get(hostId);
    if (previous && !previous.closed) {
      previous.focus();
      return;
    }
    const url = new URL(
      "/h/" + encodeURIComponent(hostId) + "/plugin/projets/surface/main",
      window.location.href,
    );
    url.searchParams.set("param.fenetre", "projets");
    const child = window.open(
      url.href,
      "paseo-projets-" + hostId,
      "popup,width=1160,height=800,resizable=yes",
    );
    if (!child) {
      toast.error("Autorisez l’ouverture de la fenêtre Projets.");
      return;
    }
    windows.set(hostId, child);
    child.focus();
  }, [hostId, toast]);
  return (
    <button
      className="projectsWindowOpen"
      type="button"
      aria-label="Ouvrir Projets dans une nouvelle fenêtre"
      title="Ouvrir Projets dans une nouvelle fenêtre"
      onClick={open}
    >
      <Icon name="ExternalLink" size={14} color="currentColor" />
    </button>
  );
}

export function BoardWindow({ children }: { children: ReactNode }) {
  useEffect(() => {
    const previous = document.title;
    document.title = "Projets";
    return () => {
      document.title = previous;
    };
  }, []);
  return createPortal(
    <div className="projectsDetached">
      <style>{`
.projectsDetached { position:fixed; inset:0; z-index:0; display:flex; flex-direction:column; height:100dvh; min-width:0; background:var(--colors-surface-sidebar,#eff0f3); }
.projectsDetachedTitle { display:flex; align-items:center; gap:8px; min-height:38px; padding:0 14px 0 80px; font:600 14px system-ui; background:var(--colors-surface-0,#fff); color:var(--colors-foreground,#353531); -webkit-app-region:drag; }
`}</style>
      <div className="projectsDetachedTitle">
        <span data-projects-window-title="">Projets</span>
      </div>
      {children}
    </div>,
    document.body,
  );
}
