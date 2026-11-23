import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginDesktopCaptureFields } from "@getpaseo/plugin/client";
import {
  DesktopCaptureDraftSchema,
  type DesktopCaptureDraft,
} from "@getpaseo/protocol/desktop-capture";
import { getDesktopHost } from "@/desktop/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { connectionFromListen } from "@/types/host-connection";
import { Button } from "@/components/ui/button";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { useInstalledPlugin } from "@/plugins/registry";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import type { Theme } from "@/styles/theme";
import { toPluginTheme } from "@/plugins/theme";
import { DesktopControlHost } from "./control-host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { CaptureCanvas } from "./canvas";
import { useHoldCapture } from "./use-hold-capture";

export function DesktopCaptureScreen() {
  const bridge = getDesktopHost()?.desktopCapture;
  const [host, setHost] = useState<{ serverId: string; deviceId: string } | null>(null);
  const [capture, setCapture] = useState<DesktopCaptureDraft | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState({ text: "", warning: "" });
  const displayed = useRef<string | null>(null);
  const holdReady = useStableEvent((value: DesktopCaptureDraft, text: string, failure: string) => {
    displayed.current = value.id;
    setInput({ text, warning: failure });
    setCapture(value);
    void bridge?.present();
  });
  const hold = useHoldCapture(bridge, host?.serverId ?? null, holdReady);
  useEffect(() => {
    if (!bridge) return;
    const accept = (value: unknown) => {
      if (value) {
        const parsed = DesktopCaptureDraftSchema.parse(value);
        if (displayed.current === parsed.id) {
          setCapture(parsed);
          return;
        }
        if (parsed.gesture && hold.capture(parsed)) return;
        displayed.current = parsed.id;
        setInput({ text: "", warning: "" });
        setCapture(parsed);
        if (parsed.gesture) void bridge.present();
      } else {
        displayed.current = null;
        setCapture(null);
        setInput({ text: "", warning: "" });
      }
    };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const prepareHost = async () => {
      try {
        const [status, deviceId] = await Promise.all([getDesktopDaemonStatus(), bridge.device()]);
        if (disposed) return;
        if (status.status === "running" && status.serverId && status.listen) {
          const runtime = getHostRuntimeStore();
          await runtime.boot();
          const connection = connectionFromListen(status.listen);
          if (!connection) throw new Error("Local connection unavailable");
          const local = runtime.getHosts().find((entry) => entry.serverId === status.serverId);
          if (!local?.connections.some((entry) => entry.id === connection.id)) {
            const registered = await runtime.probeAndUpsertConnection({
              connection,
              timeoutMs: 5000,
            });
            if (registered.serverId !== status.serverId) throw new Error("Local daemon changed");
          }
          if (!disposed) {
            setHost({ serverId: status.serverId, deviceId });
            setError("");
          }
        } else timer = setTimeout(() => void prepareHost(), 1000);
      } catch {
        if (!disposed) {
          setError("Connexion à Paseo indisponible.");
          timer = setTimeout(() => void prepareHost(), 1000);
        }
      }
    };
    void prepareHost();
    let updated = false;
    const off = bridge.onUpdate((value) => {
      updated = true;
      accept(value);
    });
    void bridge
      .getDraft()
      .then((value) => {
        if (!disposed && !updated) accept(value);
        return;
      })
      .catch(() => setError("Capture indisponible."));
    return () => {
      disposed = true;
      clearTimeout(timer);
      off();
    };
  }, [bridge, hold]);
  const close = useCallback(() => {
    hold.cancel();
    void bridge?.cancel();
  }, [bridge, hold]);
  if (!bridge) return null;
  return (
    <>
      {host ? <DesktopControlHost serverId={host.serverId} deviceId={host.deviceId} /> : null}
      {capture ? (
        <CaptureRequest key={capture.id} capture={capture} input={input} close={close} />
      ) : (
        <View style={styles.page}>
          <Text style={styles.text}>
            {error || (host ? "Prêt à capturer" : "Connexion à Paseo…")}
          </Text>
        </View>
      )}
    </>
  );
}

function captureFile(png: string, name: string) {
  const data = Uint8Array.from(atob(png), (byte) => byte.charCodeAt(0));
  return new File([data], name, { type: "image/png" });
}

const EMPTY_PARAMS = {};
const CAPTURE_LAYOUT = { compact: false, platform: "web" } as const;

function CaptureRequestView({
  capture,
  input,
  close,
  theme,
}: {
  capture: DesktopCaptureDraft;
  input: { text: string; warning: string };
  close(): void;
  theme: PluginTheme;
}) {
  const plugin = useInstalledPlugin(capture.serverId, "projets");
  const Surface = plugin?.surfaces.find((entry) => entry.id === "desktop-capture")?.Component;
  const originalFiles = useMemo(
    () => [
      captureFile(capture.png, "Capture.png"),
      ...(capture.cropPng ? [captureFile(capture.cropPng, "Zone.png")] : []),
    ],
    [capture.png, capture.cropPng],
  );
  const [fields, setFields] = useState<PluginDesktopCaptureFields>(() => ({
    project: "",
    text: input.text,
    files: originalFiles,
  }));
  const update = useCallback((changes: Partial<PluginDesktopCaptureFields>) => {
    setFields((current) => ({ ...current, ...changes }));
  }, []);
  const [mode, setMode] = useState<"rectangle" | "pen">("rectangle");
  const rectangle = useCallback(() => setMode("rectangle"), []);
  const pen = useCallback(() => setMode("pen"), []);
  const captureFileCount = useRef(originalFiles.length);
  const annotate = useCallback((images: string[]) => {
    const files = images.map((image, index) =>
      captureFile(image.split(",")[1], index === 0 ? "Capture.png" : "Zone.png"),
    );
    const previousCount = captureFileCount.current;
    captureFileCount.current = files.length;
    setFields((current) => ({
      ...current,
      files: [...files, ...current.files.slice(previousCount)],
    }));
  }, []);
  const preview = useMemo(
    () =>
      capture.gesture ? undefined : (
        <View style={styles.tools}>
          <ScrollView style={styles.preview}>
            <CaptureCanvas png={capture.png} mode={mode} disabled={false} onChange={annotate} />
          </ScrollView>
          <View style={styles.actions}>
            <Button variant={mode === "rectangle" ? "secondary" : "ghost"} onPress={rectangle}>
              Rectangle
            </Button>
            <Button variant={mode === "pen" ? "secondary" : "ghost"} onPress={pen}>
              Crayon
            </Button>
          </View>
        </View>
      ),
    [capture.gesture, capture.png, mode, annotate, rectangle, pen],
  );
  const showUnavailable = useCallback(
    () => (
      <View style={styles.page}>
        <Text style={styles.text}>Projets indisponible. Brouillon conservé.</Text>
        <Button variant="ghost" onPress={close}>
          Annuler
        </Button>
      </View>
    ),
    [close],
  );
  const localHost = useMemo(() => ({ id: capture.serverId, label: "Local" }), [capture.serverId]);
  const desktopCapture = useMemo(
    () => ({
      id: capture.id,
      context: capture.context,
      ocr: capture.ocr,
      warning: input.warning,
      fields,
      update,
      close,
      preview,
    }),
    [capture, input.warning, fields, update, close, preview],
  );
  if (!plugin || !Surface) return showUnavailable();
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Surface} renderError={showUnavailable}>
      <PluginInstallationProvider plugin={plugin}>
        <Surface
          params={EMPTY_PARAMS}
          isFocused
          host={localHost}
          theme={theme}
          layout={CAPTURE_LAYOUT}
          desktopCapture={desktopCapture}
        />
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

const CaptureRequest = withUnistyles(CaptureRequestView, (theme: Theme) => ({
  theme: toPluginTheme(theme),
}));

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  tools: { gap: theme.spacing[2] },
  preview: { maxHeight: 230 },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
}));
