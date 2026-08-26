import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

export function StatusCard(props: { readonly title: string; readonly status: string; readonly children?: ReactNode }) {
  return <View accessible accessibilityRole="summary" accessibilityLabel={`${props.title}: ${props.status}`} style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
    <Text style={styles.status}>{props.status}</Text>
    {props.children}
  </View>;
}
const styles = StyleSheet.create({ card: { borderColor: "#59636e", borderWidth: 2, borderRadius: 12, padding: 16, gap: 8 },
  title: { color: "#15202b", fontSize: 20, fontWeight: "700" }, status: { color: "#263849", fontSize: 17 } });
