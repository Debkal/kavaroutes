import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { StatusCard } from "../src/components/StatusCard";
import { DRIVER_ROUTES } from "../src/routes";
export default function BootstrapScreen() { return <FeasibilityScreen title="Driver feasibility" summary="Synthetic local evaluation. Server state remains authoritative.">
  <StatusCard title="Encrypted workspace" status="Reauthentication required before local data opens." />
  <View style={styles.links}>{Object.entries(DRIVER_ROUTES).filter(([key]) => key !== "BOOTSTRAP").map(([key, href]) => <Link key={key} href={href as never} asChild>
    <Pressable accessibilityRole="button" style={styles.button}><Text style={styles.label}>{key.replaceAll("_", " ")}</Text></Pressable></Link>)}</View>
</FeasibilityScreen>; }
const styles = StyleSheet.create({ links: { gap: 12 }, button: { backgroundColor: "#0b6e4f", minHeight: 48, justifyContent: "center", paddingHorizontal: 16, borderRadius: 8 }, label: { color: "white", fontSize: 17, fontWeight: "700" } });
