import { useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ATTESTATION_POLICY_VERSION, validateSignatureStroke, type SignerRole } from "@kavaroutes/driver-core";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { createEvidenceDigest } from "../src/crypto";
import { useWorkflow } from "../src/workflow-context";
import { queueSyntheticEvidence, saveSyntheticEvidence, supersedeSyntheticEvidence } from "../src/nativeActions";
type Point = { readonly x: number; readonly y: number };
const roles: readonly SignerRole[] = ["RIDER", "GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE", "FACILITY_EMPLOYEE", "DRIVER", "RIDER_UNABLE_TO_SIGN"];
export default function SignatureScreen() {
  const router = useRouter(); const { state, dispatch } = useWorkflow(); const [points, setPoints] = useState<readonly Point[]>([]); const pointsRef = useRef<readonly Point[]>([]);
  const [role, setRole] = useState<SignerRole>("RIDER"); const [unableReason, setUnableReason] = useState<"DECLINED" | "PHYSICALLY_UNABLE" | "NO_AUTHORIZED_SIGNER">("PHYSICALLY_UNABLE"); const [witness, setWitness] = useState(""); const [message, setMessage] = useState("");
  const signerRoles = state.effectivePolicy?.commercialTier === "SMALL_BUSINESS" ? (["RIDER", "DRIVER"] as const) : roles;
  const add = (point: Point) => { const next = [...pointsRef.current, point].slice(-600); pointsRef.current = next; setPoints(next); };
  const pan = useMemo(() => PanResponder.create({ onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => add({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }),
    onPanResponderMove: (event) => add({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }) }), []);
  const clear = () => { pointsRef.current = []; setPoints([]); setMessage("Canvas cleared. Please draw again."); };
  const undo = () => { const next = pointsRef.current.slice(0, Math.max(0, pointsRef.current.length - 12)); pointsRef.current = next; setPoints(next); };
  const accept = async () => { try {
    if (role !== "RIDER_UNABLE_TO_SIGN" && !validateSignatureStroke(points)) throw new Error("Please draw a fuller mark before continuing.");
    if (role === "RIDER_UNABLE_TO_SIGN" && witness.trim().length < 2) throw new Error("Driver or witness attestation is required.");
    const action = state.stopStep === "SIGNATURE_REQUIRED" ? "PICKUP_ATTESTATION" : "DROPOFF_ATTESTATION";
    const raw = JSON.stringify({ action, role, points: points.map((point) => [Math.round(point.x), Math.round(point.y)]), unableReason: role === "RIDER_UNABLE_TO_SIGN" ? unableReason : undefined, witness: role === "RIDER_UNABLE_TO_SIGN" });
    const digest = await createEvidenceDigest(`SIGNATURE:${raw}`); const previous = state.evidenceByNode[`node_${state.currentNode}`];
    if (previous?.digest === digest) throw new Error("This exact mark is already queued. Clear it and draw again to replace it.");
    const evidenceId = await saveSyntheticEvidence("SIGNATURE", raw); await queueSyntheticEvidence(evidenceId); if (previous) await supersedeSyntheticEvidence(previous.evidenceId); const now = new Date().toISOString();
    const next = await dispatch({ type: "SAVE_SIGNATURE", evidence: { evidenceId, stopReference: `ref_synthetic_stop_${String(state.currentNode + 1).padStart(4, "0")}`, action, role,
      attestationPolicyVersion: ATTESTATION_POLICY_VERSION, capturedAt: now, localActionAt: now, installationGeneration: "inst_synthetic0000001",
      shiftGeneration: state.shiftGeneration, digest, locationEvidence: "SEPARATE_NOT_CAPTURED", state: "QUEUED",
      ...(role === "RIDER_UNABLE_TO_SIGN" ? { unableReason, witnessedByDriver: true as const } : {}) } });
    router.replace(next.stopStep === "COMPLETE" ? "/return" : "/");
  } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not save this attestation"); } };
  if (state.moving) return <FeasibilityScreen title="Signature unavailable while moving" summary="Park safely before handing the device to a signer." />;
  return <FeasibilityScreen title="Signature attestation" summary="Only this made-up stop is visible while the signer has the phone. A signature is an attestation artifact, not biometric identity proof or server acceptance.">
    <StatusCard title="For this event only" status={`${state.currentNode < 2 ? "P" : "D"}${state.currentNode % 2 + 1} ${state.currentNode < 2 ? "pickup" : "drop-off"}`}><Text>{state.currentNode % 2 === 0 ? "Synthetic Rider A" : "Synthetic Rider B"}</Text></StatusCard>
    <Text style={styles.label}>Who is signing?</Text>{signerRoles.map((value) => <PrimaryButton key={value} label={value === "RIDER" ? "Rider signs" : value === "DRIVER" ? "Driver signs" : value.replaceAll("_", " ")} disabled={role === value} onPress={() => setRole(value)} />)}
    {role === "RIDER_UNABLE_TO_SIGN" ? <><Text style={styles.label}>Closed reason</Text>{(["DECLINED", "PHYSICALLY_UNABLE", "NO_AUTHORIZED_SIGNER"] as const).map((value) => <PrimaryButton key={value} label={value.replaceAll("_", " ")} disabled={unableReason === value} onPress={() => setUnableReason(value)} />)}<TextInput accessibilityLabel="Driver or witness attestation" placeholder="Type synthetic witness initials" value={witness} onChangeText={setWitness} style={styles.input} /></> : <>
      <Text style={styles.label}>Draw inside the box</Text><View accessible accessibilityRole="adjustable" accessibilityLabel="Signature drawing area" style={styles.canvas} {...pan.panHandlers}>{points.map((point, index) => <View key={index} style={[styles.dot, { left: point.x - 2, top: point.y - 2 }]} />)}</View>
      <PrimaryButton label="Undo last stroke" disabled={points.length === 0} onPress={undo} /><PrimaryButton label="Clear and retry" disabled={points.length === 0} onPress={clear} />
    </>}
    {message ? <StatusCard title="Signature" status={message} /> : null}<PrimaryButton label="Queue signature and continue route" busyLabel="Protecting attestation…" onPress={accept} />
  </FeasibilityScreen>;
}
const styles = StyleSheet.create({ label: { color: "#15202b", fontSize: 18, fontWeight: "700" }, canvas: { height: 240, width: "100%", backgroundColor: "white", borderWidth: 3, borderColor: "#334e68", borderRadius: 8, overflow: "hidden" }, dot: { position: "absolute", width: 5, height: 5, borderRadius: 3, backgroundColor: "#102a43" }, input: { minHeight: 52, borderWidth: 2, borderColor: "#59636e", borderRadius: 8, padding: 12, fontSize: 18, backgroundColor: "white" } });
