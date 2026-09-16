import { useState } from "react";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { manualSyntheticSync } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";
export default function SyncScreen() { const [status, setStatus] = useState({ state: "Not connected", detail: "This test app is not connected to a KavaRoutes server." });
  const { state, dispatch,cloudPrototype,recoverUpdates } = useWorkflow();
  const recover=async()=>{try{const result=await recoverUpdates('reconnect');setStatus({state:'Recovery checked',detail:result.detail+' Saved rejections and route proposals still require their own review; no command was marked accepted locally.'});}
    catch{setStatus({state:'Recovery unavailable',detail:'Original queued requests were preserved. Reconnect and retry; do not create replacements.'});}};
  const retry = async (outcome: "ACCEPTED" | "CONFLICT") => { try { const result = await manualSyntheticSync(outcome); setStatus(result); await dispatch({ type: "SYNC_OUTBOX", outcome: result.outcome }); } catch (error) { setStatus({ state: "Couldn't check updates", detail: error instanceof Error ? error.message : "Please try again." }); await dispatch({ type: "SYNC_OUTBOX", outcome: "OFFLINE" }); } };
  if(cloudPrototype)return <FeasibilityScreen title="Pending updates" summary="Recover original requests and authoritative status from the private synthetic backend. No in-process fake acceptance is used.">
    <StatusCard title="Workflow checkpoint" status={state.phase.replaceAll('_',' ')} />
    <StatusCard title="Recovery status" status={status.state==='Not connected'?'Not checked':status.state}><Text>{status.state==='Not connected'?'Use recovery to check the backend. Local queue counts are available in App details.':status.detail}</Text></StatusCard>
    <PrimaryButton label="Recover private backend updates" busyLabel="Recovering original requests…" onPress={recover} />
    <Text>Inspect saved route proposals in the route editor. Rejected commands require explicit review; recovery is not automatic approval.</Text>
  </FeasibilityScreen>;
  return <FeasibilityScreen title="Pending updates" summary="Exercise the encrypted queue against an in-process synthetic server. No public or production server is contacted.">
    <StatusCard title="Workflow updates" status={`${state.eventOutbox.length} waiting · ${state.syncState.replaceAll("_", " ")}`} />
    <StatusCard title="Update status" status={status.state}><Text>{status.detail}</Text></StatusCard>
    <PrimaryButton label="Send to synthetic server" busyLabel="Sending protected updates…" onPress={() => retry("ACCEPTED")} /><PrimaryButton label="Test a server version conflict" onPress={() => retry("CONFLICT")} />
  </FeasibilityScreen>; }
