import { useCallback, useMemo, type ReactNode, type Ref } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import type { View } from "react-native";
import { projectColors } from "./styles.js";

export function ProjectButton({
  children,
  onPress,
  disabled,
  expanded,
  primary,
  testID,
  ref,
}: {
  children: ReactNode;
  onPress(): void;
  disabled?: boolean;
  expanded?: boolean;
  primary?: boolean;
  testID?: string;
  ref?: Ref<View>;
}) {
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.button,
      primary && styles.primary,
      pressed && (primary ? styles.primaryPressed : styles.pressed),
      disabled && styles.disabled,
    ],
    [disabled, primary],
  );
  const labelStyle = useMemo(() => [styles.label, primary && styles.primaryLabel], [primary]);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      aria-expanded={expanded}
      disabled={disabled}
      onPress={onPress}
      style={style}
      testID={testID}
    >
      <Text style={labelStyle}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: "flex-start",
    justifyContent: "center",
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: projectColors.control,
  },
  pressed: { backgroundColor: projectColors.accent },
  primary: { backgroundColor: projectColors.foreground },
  primaryPressed: { opacity: 0.85 },
  primaryLabel: { color: projectColors.surface1 },
  disabled: { opacity: 0.5 },
  label: { color: projectColors.foreground, fontSize: 12 },
});
