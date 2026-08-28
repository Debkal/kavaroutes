import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useState } from "react";
import { actionLabel } from "@kavaroutes/driver-core";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { openSyntheticNavigation } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";

export default function ShiftHomeScreen() {
  const router = useRouter(); const { state, ready, error, startShift, dispatch } = useWorkflow();
  const [directionsMessage, setDirectionsMessage] = useState("");
  const nodes = [
    { label: "P1 · Pickup", time: "8:00–8:15 AM", rider: "Synthetic Rider A", place: "Demo Civic Center" },
    { label: "P2 · Pickup", time: "8:12–8:27 AM", rider: "Synthetic Rider B", place: "Demo Public Library" },
    { label: "D1 · Drop-off", time: "8:35–8:50 AM", rider: "Synthetic Rider A", place: "Demo Community Center" },
    { label: "D2 · Drop-off", time: "8:48–9:03 AM", rider: "Synthetic Rider B", place: "Demo Arts Center" },
  ] as const; const node = nodes[Math.min(state.currentNode, nodes.length - 1)]!; const nodeKind = state.currentNode < 2 ? "PICKUP" : "DROPOFF";
  const smallBusiness = state.effectivePolicy?.commercialTier === "SMALL_BUSINESS";
  const start = async () => { const next = await startShift(); router.replace(next.effectivePolicy?.commercialTier === "SMALL_BUSINESS" ? "/" : "/inspection"); };
  const startSmallBusinessRoute = async () => {
    let next = state;
    if (next.phase === "POLICY_RESOLVED") next = await dispatch({ type: "CONFIRM_VEHICLE" });
    if (next.phase === "PRECHECK_OFFERED") await dispatch({ type: "SKIP_PRECHECK", reason: "OPTIONAL_CONTROL_SKIPPED" });
    router.replace("/");
  };
  const directions = async () => { try { await openSyntheticNavigation(state.currentNode); setDirectionsMessage(""); } catch (cause) { setDirectionsMessage(cause instanceof Error ? cause.message : "Directions could not be opened."); } };
  const confirmStop = async () => {
    if (state.stopStep === "SIGNATURE_REQUIRED" || state.stopStep === "DROPOFF_EVIDENCE_REQUIRED") { router.push("/signature"); return; }
    if (state.stopStep === "NAVIGATE") { await dispatch({ type: "ADVANCE_STOP" }); router.push("/signature"); return; }
    router.push(`/stop/ref_synthetic_stop_${String(state.currentNode + 1).padStart(4, "0")}` as never);
  };
  if (!ready) return <FeasibilityScreen title="Opening your shift" summary="Loading protected test data from this phone." />;
  if (state.phase === "SIGNED_OUT") return <FeasibilityScreen title="Ready for your day?" summary="This candidate uses made-up riders, stops, and receipts. Starting the shift is intentional and also starts visible location sharing.">
    <StatusCard title="Assigned vehicle" status="Synthetic Van 12"><Text>Run: TEST-204 · 1 rider · 2 stops</Text></StatusCard>
    {error ? <StatusCard title="Protected storage" status="Needs attention"><Text>{error}</Text></StatusCard> : null}
    <PrimaryButton label="Sign in & start shift" busyLabel="Starting shift and location…" onPress={start} />
  </FeasibilityScreen>;
  if (smallBusiness && ["POLICY_RESOLVED", "PRECHECK_OFFERED"].includes(state.phase)) return <FeasibilityScreen title="Ready to start your route?" summary="Confirm your van and get to the first pickup. The longer vehicle check is available when you want it, but it is not required for this assigned shift.">
    <StatusCard title="Today's van" status="Synthetic Van 12"><Text>Run TEST-204 · 2 riders · 4 stops</Text></StatusCard>
    <PrimaryButton label="Confirm van and start route" busyLabel="Starting today's route…" onPress={startSmallBusinessRoute} />
    <PrimaryButton label="Do the optional vehicle check" onPress={() => router.push("/inspection")} />
    <PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>;
  if (["POLICY_RESOLVED", "PRECHECK_REQUIRED", "PRECHECK_OFFERED", "BLOCKED_CRITICAL_DEFECT"].includes(state.phase)) return <FeasibilityScreen title={state.phase === "PRECHECK_OFFERED" ? "Optional vehicle controls" : "Vehicle controls"} summary="Your assigned shift settings decide which vehicle controls are required, optional, or not assigned.">
    <StatusCard title="Shift" status={state.phase === "BLOCKED_CRITICAL_DEFECT" ? "Vehicle out of service" : state.phase === "PRECHECK_OFFERED" ? "Tracking on · optional controls offered" : "Tracking on · vehicle confirmation due"}><Text>{state.lastReceipt}</Text></StatusCard>
    {state.effectivePolicy ? <StatusCard title="Assigned operating policy" status={`${state.effectivePolicy.commercialTier.replaceAll("_", " ")} · ${state.effectivePolicy.workforceRelationship.replaceAll("_", " ")}`}><Text>These settings came with this shift and cannot be changed in the Driver app.</Text></StatusCard> : null}
    <PrimaryButton label="Continue vehicle check" onPress={() => router.push("/inspection")} />
    <PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>;
  if (state.phase === "POSTCHECK_REQUIRED" || state.phase === "POSTCHECK_OFFERED" || state.phase === "SIGNOFF_PENDING" || state.phase === "RETURN_LOCATION_EXCEPTION") return <FeasibilityScreen title="Finish your shift" summary="Complete or explicitly skip only the controls allowed by the pinned policy. Location sharing stops after accepted sign-off.">
    <StatusCard title="Return status" status={state.phase.replaceAll("_", " ")}><Text>{state.lastReceipt}</Text></StatusCard>
    <PrimaryButton label="Continue return and sign-off" onPress={() => router.push("/return")} />
    <PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>;
  if (state.phase === "SHIFT_ENDED" || state.phase === "EMERGENCY_STOPPED") return <FeasibilityScreen title={state.phase === "SHIFT_ENDED" ? "Shift complete" : "Location sharing stopped"} summary={state.phase === "SHIFT_ENDED" ? "Your synthetic shift ended and continuous location collection is off." : "Location collection is off. Dispatch has a synthetic alert and the shift still needs review."}>
    <StatusCard title="Last receipt" status={state.lastReceipt}><Text>Pending events: {state.eventOutbox.length}</Text></StatusCard>
    <PrimaryButton label="View app details" onPress={() => router.push("/diagnostics")} />
  </FeasibilityScreen>;
  return <FeasibilityScreen title="Today's route" summary="The itinerary is your in-shift home. Review the full day only while safely parked.">
    <StatusCard title="Run TEST-204 · Synthetic Van 12" status="2 riders · 4 stops · 63 min · 22 mi"><Text>First pickup 8:00 AM · last drop-off 9:03 AM</Text></StatusCard>
    <StatusCard title="Tracking and updates" status={smallBusiness ? `${state.tracking === "TRACKING" ? "Location on" : state.tracking} · ${state.eventOutbox.length} saved update${state.eventOutbox.length === 1 ? "" : "s"}` : `${state.tracking === "TRACKING" ? "Location sharing on" : state.tracking} · ${state.eventOutbox.length} updates waiting · ${state.syncState.replaceAll("_", " ")}`}>{!smallBusiness ? <Text>{state.lastReceipt}</Text> : null}</StatusCard>
    <StatusCard title="Current / next stop" status={`${node.label} · ${node.time}`}><Text>{node.rider} · {state.currentNode === 0 ? "1 companion" : "no companions"}</Text><Text>{state.currentNode % 2 === 0 ? "Wheelchair · lift · securement" : "Door-to-door assistance"}</Text><Text>{node.place}</Text><Text>Grouped load · rider {state.currentNode % 2 + 1} of 2</Text></StatusCard>
    <PrimaryButton label="Open directions" busyLabel="Opening directions…" onPress={directions} />
    {directionsMessage ? <StatusCard title="Directions" status={directionsMessage} /> : null}
    <PrimaryButton label={actionLabel(state.stopStep, nodeKind)} disabled={state.moving} onPress={confirmStop} />
    {!state.moving ? <View style={{ gap: 12 }}><PrimaryButton label={smallBusiness ? "See all today's stops" : "Review full itinerary"} onPress={() => router.push("/manifest")} />{state.effectivePolicy?.routeChange.mode !== "DISABLED" ? <PrimaryButton label={smallBusiness ? "Change the stop order" : "Propose a route change"} onPress={() => router.push("/proposal")} /> : <StatusCard title="Route changes" status="Disabled by assigned policy"><Text>The Driver cannot weaken or switch this setting.</Text></StatusCard>}{!smallBusiness ? <PrimaryButton label="Check pending updates" onPress={() => router.push("/sync")} /> : null}</View> : <StatusCard title="Vehicle moving" status="Park to use route tools"><Text>Directions and emergency stop remain available.</Text></StatusCard>}
    <PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>;
}
