import type { HtmlArtifactProps } from "./artifact";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useArtifact, type ArtifactCommand } from "./use-artifact";
import { styles } from "./styles";
export function HtmlArtifact({ html, name, colorScheme = "light" }: HtmlArtifactProps) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const post = useCallback(
    (command: ArtifactCommand) => frame.current?.contentWindow?.postMessage(command, "*"),
    [],
  );
  const runtime = useArtifact({ html, name, post, colorScheme });
  const { receive, height } = runtime;
  const frameStyle = useMemo(() => ({ width: "100%", height, border: 0 }), [height]);
  useEffect(() => {
    function message(event: MessageEvent<unknown>) {
      if (event.source === frame.current?.contentWindow) receive(event.data);
    }
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, [receive]);
  if (!runtime.mounted) return null;
  return (
    <View style={styles.content}>
      {runtime.status === "loading" ? (
        <Text style={styles.muted}>{t("interactive.loading")}</Text>
      ) : null}
      {runtime.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("interactive.renderError")}
        </Text>
      ) : null}
      {runtime.status !== "error" ? (
        <iframe
          key={runtime.revision}
          ref={frame}
          title={t("interactive.artifact")}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={runtime.source}
          style={frameStyle}
        />
      ) : null}
      <Button size="sm" variant="ghost" onPress={runtime.reload}>
        {t("interactive.reload")}
      </Button>
    </View>
  );
}
