import { useRouter } from "expo-router";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { evaluateReturnLocation, openSyntheticNavigation } from "../src/nativeActions";
import { useWorkflow } from "../src/workflow-context";
export default function ReturnScreen() { const router = useRouter(); const { state, dispatch } = useWorkflow();
  const begin = async () => { const next = await dispatch({ type: "BEGIN_RETURN" }); if (next.phase === "POSTCHECK_REQUIRED" || (next.phase === "POSTCHECK_OFFERED" && next.effectivePolicy?.commercialTier !== "SMALL_BUSINESS")) router.push("/inspection"); };
  const skipOptionalPostcheck = async () => { await dispatch({ type: "SKIP_POSTCHECK", reason: "OPTIONAL_CONTROL_SKIPPED" }); router.replace("/return"); };
  const signoff = async (location: "PASS" | "OUTSIDE" | "STALE" | "INACCURATE" | "UNAVAILABLE", override = false) => { const next = await dispatch({ type: "SIGN_OFF", location, override }); if (next.phase === "SHIFT_ENDED") router.replace("/"); };
  const evaluate = async () => signoff(await evaluateReturnLocation());
  if (state.phase === "ITINERARY_ACTIVE" || state.phase === "READY") return <FeasibilityScreen title="Return the vehicle" summary="After the last leg, navigate to the authorized synthetic return location, park, and complete the post-trip check."><PrimaryButton label="Open return directions (no status change)" onPress={openSyntheticNavigation} /><PrimaryButton label="Vehicle returned and parked" onPress={begin} /></FeasibilityScreen>;
  if (state.phase === "POSTCHECK_OFFERED" && state.effectivePolicy?.commercialTier === "SMALL_BUSINESS") return <FeasibilityScreen title="Ready to finish your day?" summary="The vehicle check is optional for this assigned shift. You can finish now or complete it first."><PrimaryButton label="Finish without the optional vehicle check" busyLabel="Finishing your route…" onPress={skipOptionalPostcheck} /><PrimaryButton label="Do the optional vehicle check" onPress={() => router.push("/inspection")} /></FeasibilityScreen>;
  if (state.phase === "POSTCHECK_REQUIRED" || state.phase === "POSTCHECK_OFFERED") return <FeasibilityScreen title={state.phase === "POSTCHECK_REQUIRED" ? "Post-trip controls required" : "Optional post-trip controls"} summary="Your assigned shift settings decide whether the checklist and ending odometer are required or may be skipped."><PrimaryButton label="Review post-trip controls" onPress={() => router.push("/inspection")} /></FeasibilityScreen>;
  const returnMode = state.effectivePolicy?.returnVerification.mode;
  if (returnMode === "DISABLED") return <FeasibilityScreen title="Sign off" summary="Return-location verification is not assigned for this shift. KavaRoutes will not collect a return sample for this purpose."><StatusCard title="Pinned return policy" status="Disabled"><Text>Tracking transparency and emergency stop remain available.</Text></StatusCard><PrimaryButton label="Sign off without return sample" onPress={() => signoff("UNAVAILABLE")} /><PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} /></FeasibilityScreen>;
  return <FeasibilityScreen title="Sign off" summary={returnMode === "ADVISORY" ? "Return location is advisory. A neutral exception is recorded without labeling misconduct or blocking sign-off." : "A fresh, accurate return-location evaluation is required unless an authorized audited override is received. GPS is never misconduct proof."}>
    <StatusCard title="Return-location evaluation" status={state.phase === "RETURN_LOCATION_EXCEPTION" ? "Needs neutral review" : "Ready to evaluate"}><Text>{state.lastReceipt}</Text></StatusCard>
    <PrimaryButton label="Evaluate return location and sign off" busyLabel="Checking return location…" onPress={evaluate} />
    {state.phase === "RETURN_LOCATION_EXCEPTION" && returnMode === "REQUIRED_WITH_AUDITED_OVERRIDE" ? <StatusCard title="Override required" status="Waiting for authorized dispatch"><Text>The Driver cannot approve its own return-location override.</Text></StatusCard> : null}
    <PrimaryButton label="Emergency: stop location sharing" onPress={() => dispatch({ type: "EMERGENCY_STOP", reason: "SAFETY" })} />
  </FeasibilityScreen>; }
