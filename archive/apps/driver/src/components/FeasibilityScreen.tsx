import type { ReactNode } from "react";
import { useEffect } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { disableAppSwitcherProtectionAsync, enableAppSwitcherProtectionAsync, usePreventScreenCapture } from "expo-screen-capture";

export function FeasibilityScreen(props: { readonly title: string; readonly summary: string; readonly children?: ReactNode }) {
  usePreventScreenCapture("wp010-sensitive-surface");
  useEffect(() => { void enableAppSwitcherProtectionAsync(0.85); return () => { void disableAppSwitcherProtectionAsync(); }; }, []);
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.page} contentContainerStyle={styles.content}>
    <View accessibilityRole="header"><Text style={styles.title}>{props.title}</Text></View>
    <Text accessibilityLiveRegion="polite" style={styles.summary}>{props.summary}</Text>{props.children}
  </ScrollView>;
}
const styles = StyleSheet.create({ page: { backgroundColor: "#f7fafc" }, content: { padding: 20, gap: 16 }, title: { color: "#102a43", fontSize: 30, fontWeight: "800" },
  summary: { color: "#334e68", fontSize: 18, lineHeight: 26 } });
