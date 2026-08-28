import { useState } from "react";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { manualSyntheticSync } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";
export default function SyncScreen() { const [status, setStatus] = useState({ state: "Not connected", detail: "This test app is not connected to a KavaRoutes server." });
  const { state, dispatch } = useWorkflow();
  const retry = async (outcome: "ACCEPTED" | "CONFLICT") => { try { const result = await manualSyntheticSync(outcome); setStatus(result); await dispatch({ type: "SYNC_OUTBOX", outcome: result.outcome }); } catch (error) { setStatus({ state: "Couldn't check updates", detail: error instanceof Error ? error.message : "Please try again." }); await dispatch({ type: "SYNC_OUTBOX", outcome: "OFFLINE" }); } };
  return <FeasibilityScreen title="Pending updates" summary="Exercise the encrypted queue against an in-process synthetic server. No public or production server is contacted.">
    <StatusCard title="Workflow updates" status={`${state.eventOutbox.length} waiting · ${state.syncState.replaceAll("_", " ")}`} />
    <StatusCard title="Update status" status={status.state}><Text>{status.detail}</Text></StatusCard>
    <PrimaryButton label="Send to synthetic server" busyLabel="Sending protected updates…" onPress={() => retry("ACCEPTED")} /><PrimaryButton label="Test a server version conflict" onPress={() => retry("CONFLICT")} />
  </FeasibilityScreen>; }
