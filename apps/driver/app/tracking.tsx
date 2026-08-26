import { Pressable, StyleSheet, Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { StatusCard } from "../src/components/StatusCard";
export default function TrackingScreen() { return <FeasibilityScreen title="Tracking permission" summary="Tracking starts only after an explicit driver action and approved precise background permission.">
  <StatusCard title="Tracking" status="STOPPED BY DRIVER"><Text>No location task is running.</Text></StatusCard>
  <Pressable accessibilityRole="button" accessibilityHint="Reviews permission before starting" style={styles.button}><Text style={styles.label}>Review and start synthetic shift</Text></Pressable>
</FeasibilityScreen>; }
const styles = StyleSheet.create({ button: { minHeight: 48, borderRadius: 8, justifyContent: "center", padding: 12, backgroundColor: "#0b6e4f" }, label: { color: "white", fontSize: 17, fontWeight: "700" } });
