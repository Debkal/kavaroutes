import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "react-native";
import { actionLabel } from "@kavaroutes/driver-core";
import { FeasibilityScreen } from "../../src/components/FeasibilityScreen";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { StatusCard } from "../../src/components/StatusCard";
import { openSyntheticNavigation } from "../../src/nativeActions";
import { useWorkflow } from "../../src/workflow-context";
import { useState } from "react";
export default function StopDetailScreen() {
  const { reference } = useLocalSearchParams<{ reference: string }>(); const router = useRouter(); const { state, dispatch } = useWorkflow();
  const [showExceptions, setShowExceptions] = useState(false); const [directionsMessage, setDirectionsMessage] = useState("");
  const safe = reference === `ref_synthetic_stop_${String(state.currentNode + 1).padStart(4, "0")}`;
  if (!safe) return <FeasibilityScreen title="Stop unavailable" summary="That safe stop reference is not part of this shift." />;
  const nodes = [
    { label: "P1 · Pickup", rider: "Synthetic Rider A", place: "Demo Civic Center · 8:00–8:15 AM", equipment: "Wheelchair · lift · securement" },
    { label: "P2 · Pickup", rider: "Synthetic Rider B", place: "Demo Public Library · 8:12–8:27 AM", equipment: "Door-to-door assistance" },
    { label: "D1 · Drop-off", rider: "Synthetic Rider A", place: "Demo Community Center · 8:35–8:50 AM", equipment: "Wheelchair · lift · securement" },
    { label: "D2 · Drop-off", rider: "Synthetic Rider B", place: "Demo Arts Center · 8:48–9:03 AM", equipment: "Door-to-door assistance" },
  ] as const; const node = nodes[Math.min(state.currentNode, 3)]!; const pickup = state.currentNode < 2;
  const act = async () => {
    if (state.stopStep === "SIGNATURE_REQUIRED" || state.stopStep === "DROPOFF_EVIDENCE_REQUIRED") { router.push("/signature"); return; }
    const next = await dispatch({ type: "ADVANCE_STOP" });
    if (next.stopStep === "SIGNATURE_REQUIRED" || next.stopStep === "DROPOFF_EVIDENCE_REQUIRED") { router.push("/signature"); return; }
    if (next.stopStep === "COMPLETE") router.replace("/return");
  };
  const directions = async () => { try { await openSyntheticNavigation(state.currentNode); setDirectionsMessage(""); } catch (cause) { setDirectionsMessage(cause instanceof Error ? cause.message : "Directions could not be opened."); } };
  return <FeasibilityScreen title={node.label} summary="Every change below is an explicit driver action. GPS and directions never mark a stop complete.">
    <StatusCard title={node.label} status={actionLabel(state.stopStep, pickup ? "PICKUP" : "DROPOFF")}><Text>{node.rider} · {state.currentNode === 0 ? "1 companion" : "no companions"}</Text><Text>{node.place}</Text><Text>{node.equipment}</Text><Text>Grouped load · individual evidence boundary</Text></StatusCard>
    <PrimaryButton label="Open directions" busyLabel="Opening directions…" onPress={directions} />
    {directionsMessage ? <StatusCard title="Directions" status={directionsMessage} /> : null}
    <PrimaryButton label={actionLabel(state.stopStep, pickup ? "PICKUP" : "DROPOFF")} disabled={state.moving && state.stopStep !== "UNLOAD_AND_ASSIST"} onPress={act} />
    {state.moving ? <StatusCard title="Motion detected" status="Vehicle appears to be moving"><Text>Pickup, drop-off, signature, and route tools unlock after three accurate stationary readings.</Text></StatusCard> : null}
    {!state.moving ? <><PrimaryButton label="Report a stop problem" onPress={() => setShowExceptions(!showExceptions)} />{showExceptions ? <><PrimaryButton label="Rider not present" onPress={() => dispatch({ type: "REPORT_STOP_EXCEPTION", reason: "RIDER_NOT_PRESENT" })} /><PrimaryButton label="Rider declined" onPress={() => dispatch({ type: "REPORT_STOP_EXCEPTION", reason: "RIDER_DECLINED" })} /><PrimaryButton label="Facility delay" onPress={() => dispatch({ type: "REPORT_STOP_EXCEPTION", reason: "FACILITY_DELAY" })} /><PrimaryButton label="Safety concern" onPress={() => dispatch({ type: "REPORT_STOP_EXCEPTION", reason: "SAFETY_CONCERN" })} /></> : null}{state.stopException !== "NONE" ? <StatusCard title="Reported problem" status={state.stopException.replaceAll("_", " ")}><Text>The stop did not auto-complete. Dispatch received a synthetic alert.</Text></StatusCard> : null}</> : null}
    <PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>;
}
