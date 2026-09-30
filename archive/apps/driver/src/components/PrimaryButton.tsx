import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";

export function PrimaryButton(props: {
  readonly label: string;
  readonly busyLabel?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly onPress: () => unknown | Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = Boolean(props.disabled || busy);
  const activate = async () => {
    if (disabled) return;
    setBusy(true);
    try { await props.onPress(); } catch { /* The owning surface presents the domain-safe error. */ } finally { setBusy(false); }
  };
  return <Pressable
    accessibilityRole="button"
    accessibilityHint={props.hint}
    accessibilityState={{ busy, disabled }}
    disabled={disabled}
    onPress={() => { void activate(); }}
    style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
  ><Text style={styles.label}>{busy ? (props.busyLabel ?? "Please wait…") : props.label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  button: { backgroundColor: "#0b6e4f", minHeight: 52, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  pressed: { backgroundColor: "#07553d" },
  disabled: { backgroundColor: "#66737d" },
  label: { color: "white", fontSize: 17, fontWeight: "700", textAlign: "center" },
});
