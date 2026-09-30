import { useRouter } from "expo-router";
import { useState, type ComponentProps } from "react";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { evaluateReturnLocation, openSyntheticNavigation } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";
// Keep failures visible for every return action, including samples and recovery.
// PrimaryButton intentionally delegates error presentation to its owning surface.
function ReturnAction(props: ComponentProps<typeof PrimaryButton>) {
  const [failed, setFailed] = useState(false);
  return <><PrimaryButton {...props} onPress={async () => {
    setFailed(false);
    try { await props.onPress(); } catch { setFailed(true); }
  }} />{failed ? <StatusCard title="Return action needs attention" status="No success confirmed"><Text>The action could not be confirmed. Recover the original server status before retrying; do not assume sign-off or create a replacement request.</Text></StatusCard> : null}</>;
}
export default function ReturnScreen() { const router = useRouter(); const { state, dispatch, cloudPrototype,sendSyntheticReturnSample,syncCloudFinish } = useWorkflow();
  const begin = async () => { const next = await dispatch({ type: "BEGIN_RETURN" }); if (next.phase === "POSTCHECK_REQUIRED" || (next.phase === "POSTCHECK_OFFERED" && next.effectivePolicy?.commercialTier !== "SMALL_BUSINESS")) router.push("/inspection"); };
  const skipOptionalPostcheck = async () => { await dispatch({ type: "SKIP_POSTCHECK", reason: "OPTIONAL_CONTROL_SKIPPED" }); router.replace("/return"); };
  const signoff = async (location: "PASS" | "OUTSIDE" | "STALE" | "INACCURATE" | "UNAVAILABLE", override = false) => { const next = await dispatch({ type: "SIGN_OFF", location, override }); if (next.phase === "SHIFT_ENDED") router.replace("/"); };
  const evaluate = async () => signoff(cloudPrototype ? 'UNAVAILABLE' : await evaluateReturnLocation());
  if (state.phase === "ITINERARY_ACTIVE" || state.phase === "READY") return <FeasibilityScreen title="Return the vehicle" summary="After the last leg, return to the authorized location, park, and review the assigned post-trip controls.">{cloudPrototype ? <StatusCard title="Return directions" status="Not configured"><Text>This private prototype does not have an approved return-navigation destination. No demo pickup coordinate or external Maps app will be substituted. Confirm the return location with dispatch.</Text></StatusCard> : <ReturnAction label="Open synthetic demo directions (not an assigned return)" onPress={openSyntheticNavigation} />}<ReturnAction label="Vehicle returned and parked" onPress={begin} /></FeasibilityScreen>;
  if (state.phase === "POSTCHECK_OFFERED" && state.effectivePolicy?.commercialTier === "SMALL_BUSINESS") return <FeasibilityScreen title="Ready to finish your day?" summary="The vehicle check is optional for this assigned shift. You can finish now or complete it first."><ReturnAction label="Finish without the optional vehicle check" busyLabel="Finishing your route…" onPress={skipOptionalPostcheck} /><ReturnAction label="Do the optional vehicle check" onPress={() => router.push("/inspection")} /></FeasibilityScreen>;
  if (state.phase === "POSTCHECK_REQUIRED" || state.phase === "POSTCHECK_OFFERED") return <FeasibilityScreen title={state.phase === "POSTCHECK_REQUIRED" ? "Post-trip controls required" : "Optional post-trip controls"} summary="Your assigned shift settings decide whether the checklist and ending odometer are required or may be skipped."><ReturnAction label="Review post-trip controls" onPress={() => router.push("/inspection")} /></FeasibilityScreen>;
  const returnMode = state.effectivePolicy?.returnVerification.mode;
  if (returnMode === "DISABLED") return <FeasibilityScreen title="Sign off" summary="Return-location verification is not assigned for this shift. KavaRoutes will not collect a return sample for this purpose."><StatusCard title="Pinned return policy" status="Disabled"><Text>Tracking transparency and emergency stop remain available.</Text></StatusCard><ReturnAction label="Sign off without return sample" onPress={() => signoff("UNAVAILABLE")} /><ReturnAction label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} /></FeasibilityScreen>;
  return <FeasibilityScreen title="Sign off" summary={returnMode === "ADVISORY" ? "Return location is advisory. A neutral exception is recorded without labeling misconduct or blocking sign-off." : "A fresh, accurate return-location evaluation is required unless an authorized audited override is received. GPS is never misconduct proof."}>
    <StatusCard title="Return-location evaluation" status={state.phase === "RETURN_LOCATION_EXCEPTION" ? "Needs neutral review" : "Ready to evaluate"}><Text>{state.lastReceipt}</Text></StatusCard>
    {cloudPrototype ? <StatusCard title="Synthetic return fixtures only" status="No device GPS uploaded"><Text>These explicit test samples are not evidence of a real vehicle position. The server applies the pinned return policy.</Text><ReturnAction label="Send test sample: at return" onPress={()=>sendSyntheticReturnSample('AT_RETURN')} /><ReturnAction label="Send test sample: outside return" onPress={()=>sendSyntheticReturnSample('OUTSIDE_RETURN')} /><ReturnAction label="Send test sample: inaccurate" onPress={()=>sendSyntheticReturnSample('INACCURATE')} /><ReturnAction label="Recover server sign-off status" onPress={syncCloudFinish} /></StatusCard> : null}
    <ReturnAction label="Evaluate return location and sign off" busyLabel="Checking return location…" onPress={evaluate} />
    {state.phase === "RETURN_LOCATION_EXCEPTION" && returnMode === "REQUIRED_WITH_AUDITED_OVERRIDE" ? <StatusCard title="Override required" status="Waiting for authorized dispatch"><Text>The Driver cannot approve its own return-location override.</Text></StatusCard> : null}
    <ReturnAction label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>; }
