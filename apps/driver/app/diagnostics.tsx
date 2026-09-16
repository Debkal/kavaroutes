import { useState } from "react";
import { Alert, Text } from "react-native";
import { useRouter } from "expo-router";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { readSafeDiagnostics,readSafeCloudDiagnostics } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";
export default function DiagnosticsScreen() { const [detail, setDetail] = useState("Tap refresh to check this phone"); const router = useRouter(); const { state, reset,cloudPrototype } = useWorkflow();
  const refresh = async () => { try {
    if(cloudPrototype){const value=await readSafeCloudDiagnostics(state.shiftReference||undefined);setDetail(`${value.pending} pending, ${value.accepted} receipted, ${value.rejected} rejected shift commands. Counts are local receipts, not a live connection check. Shift-start requests are not included.`);return;}
    const value = await readSafeDiagnostics(); setDetail(`${value.actions} arrival${value.actions === 1 ? "" : "s"}, ${value.locations} location sample${value.locations === 1 ? "" : "s"}, and ${value.evidence} saved draft${value.evidence === 1 ? "" : "s"}. Location sharing is ${value.tracking ? "on" : "off"}.`); }
    catch { setDetail("Couldn't load app details. No queue was changed."); } };
  const confirmReset = () => Alert.alert("Reset all synthetic test data?", "This stops location sharing and permanently removes the encrypted local test database and its key.", [
    { text: "Cancel", style: "cancel" }, { text: "Reset test data", style: "destructive", onPress: () => { void reset().then(() => router.replace("/")); } },
  ]);
  return <FeasibilityScreen title="App details" summary="Check the test activity stored on this phone. Addresses and exact locations are never shown here."><Text>{cloudPrototype?'Mode: Private backend prototype':'Mode: Local synthetic test'}</Text><Text>{cloudPrototype?'Synthetic identity; no production account. Device GPS is disabled.':'No live account connected'}</Text>
    <StatusCard title="Workflow checkpoint" status={state.phase.replaceAll("_", " ")}><Text>{state.lastReceipt}</Text></StatusCard>
    <StatusCard title="Saved test activity" status={detail} /><PrimaryButton label="Refresh app details" busyLabel="Checking this phone…" onPress={refresh} />{cloudPrototype?<Text>Connected receipts cannot be reset here. Recover or review pending work before changing installations.</Text>:<PrimaryButton label="Reset all synthetic test data" onPress={confirmReset} />}
  </FeasibilityScreen>; }
