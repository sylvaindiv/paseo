import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Image } from "react-native";
import { sequenceAction } from "../shared/sequence.js";

export function imageMimeType(data: string) {
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  if (data.startsWith("Qk")) return "image/bmp";
  return "image/png";
}

export function SequenceImage({ hostId, id }: { hostId: string; id: string }) {
  const rpc = useRpc(sequenceAction);
  const { data } = useQuery({
    queryKey: ["projets", "sequence-image", hostId, id],
    queryFn: async () => {
      const result = await rpc({ action: "image", id });
      return result.image ?? null;
    },
    staleTime: Infinity,
  });
  const source = useMemo(
    () => (data ? { uri: "data:" + imageMimeType(data) + ";base64," + data } : null),
    [data],
  );
  if (!source) return null;
  return (
    <Image
      source={source}
      resizeMode="contain"
      accessibilityLabel="Image jointe"
      style={imageStyle}
    />
  );
}

const imageStyle = { width: "100%", height: 120 } as const;
