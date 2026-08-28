import { useState } from "react";
import { Alert, Text } from "react-native";
import { useRouter } from "expo-router";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { readSafeDiagnostics } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";
export default function DiagnosticsScreen() { const [detail, setDetail] = useState("Tap refresh to check this phone"); const router = useRouter(); const { state, reset } = useWorkflow();
  const refresh = async () => { try { const value = await readSafeDiagnostics(); setDetail(`${value.actions} arrival${value.actions === 1 ? "" : "s"}, ${value.locations} location sample${value.locations === 1 ? "" : "s"}, and ${value.evidence} saved draft${value.evidence === 1 ? "" : "s"}. Location sharing is ${value.tracking ? "on" : "off"}.`); }
    catch (error) { setDetail(error instanceof Error ? error.message : "Couldn't load app details."); } };
  const confirmReset = () => Alert.alert("Reset all synthetic test data?", "This stops location sharing and permanently removes the encrypted local test database and its key.", [
    { text: "Cancel", style: "cancel" }, { text: "Reset test data", style: "destructive", onPress: () => { void reset().then(() => router.replace("/")); } },
  ]);
  return <FeasibilityScreen title="App details" summary="Check the test activity stored on this phone. Addresses and exact locations are never shown here."><Text>Mode: Local synthetic test</Text><Text>No live account connected</Text>
    <StatusCard title="Workflow checkpoint" status={state.phase.replaceAll("_", " ")}><Text>{state.lastReceipt}</Text></StatusCard>
    <StatusCard title="Saved test activity" status={detail} /><PrimaryButton label="Refresh app details" busyLabel="Checking this phone…" onPress={refresh} /><PrimaryButton label="Reset all synthetic test data" onPress={confirmReset} />
  </FeasibilityScreen>; }
