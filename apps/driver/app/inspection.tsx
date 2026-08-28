import { useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { File } from "expo-file-system";
import { INSPECTION_ITEMS, type DefectSeverity, type InspectionAnswer } from "@kavaroutes/driver-core";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { useWorkflow } from "../src/workflow-context";
import { queueSyntheticEvidence, saveSyntheticDefectPhoto, saveSyntheticEvidence, supersedeSyntheticDefectPhoto } from "../src/nativeActions";

export default function InspectionScreen() {
  const router = useRouter(); const { state, dispatch } = useWorkflow();
  const stage = ["POSTCHECK_REQUIRED", "POSTCHECK_OFFERED"].includes(state.phase) ? "POST" : "PRE"; const answers = stage === "PRE" ? state.preCheck : state.postCheck;
  const inspectionMode = stage === "PRE" ? state.effectivePolicy?.preInspection.mode : state.effectivePolicy?.postInspection.mode;
  const odometerMode = stage === "PRE" ? state.effectivePolicy?.startOdometer.mode : state.effectivePolicy?.endOdometer.mode;
  const firstOpen = INSPECTION_ITEMS.findIndex((item) => !answers[item]);
  const [index, setIndex] = useState(firstOpen < 0 ? INSPECTION_ITEMS.length - 1 : firstOpen);
  const [odometer, setOdometer] = useState(stage === "PRE" ? state.startOdometer?.toString() ?? "" : state.endOdometer?.toString() ?? "");
  const [fuel, setFuel] = useState<"EMPTY" | "QUARTER" | "HALF" | "THREE_QUARTERS" | "FULL">(state.fuelLevel ?? "FULL");
  const [defect, setDefect] = useState(false); const [severity, setSeverity] = useState<DefectSeverity>("MINOR"); const [note, setNote] = useState("");
  const [photoException, setPhotoException] = useState<"UNSAFE_TO_CAPTURE" | "CAMERA_UNAVAILABLE">(); const [photoDigest, setPhotoDigest] = useState<string>(); const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions(); const camera = useRef<CameraView>(null); const [message, setMessage] = useState("");
  const item = INSPECTION_ITEMS[index]!; const answered = Object.keys(answers).length;
  const save = async (answer: InspectionAnswer) => { try { await dispatch({ type: "ANSWER_INSPECTION", stage, item, answer }); setMessage("Saved securely on this phone"); setDefect(false); setNote(""); if (index < INSPECTION_ITEMS.length - 1) setIndex(index + 1); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not save this item"); } };
  const openCamera = async () => { const result = permission?.granted ? permission : await requestPermission(); if (!result.granted) { setMessage("Camera permission was not granted. Choose a closed exception reason if a photo is unsafe or impossible."); return; } setCameraOpen(true); };
  const takePhoto = async () => { let uri: string | undefined; try { const picture = await camera.current?.takePictureAsync({ base64: true, quality: 0.35, shutterSound: true }); if (!picture?.base64) throw new Error("CAMERA_DID_NOT_RETURN_PHOTO"); uri = picture.uri; const digest = await saveSyntheticDefectPhoto(picture.base64); if (photoDigest) await supersedeSyntheticDefectPhoto(photoDigest); setPhotoDigest(digest); setPhotoException(undefined); setCameraOpen(false); setMessage("Synthetic defect photo encrypted and temporary camera file removed"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not protect the photo"); } finally { if (uri) { try { new File(uri).delete(); } catch { setMessage("Photo capture failed closed while removing its temporary file"); } } } };
  const usePhotoException = async (reason: "UNSAFE_TO_CAPTURE" | "CAMERA_UNAVAILABLE") => { if (photoDigest) await supersedeSyntheticDefectPhoto(photoDigest); setPhotoException(reason); setPhotoDigest(undefined); };
  const cancelDefect = async () => { if (photoDigest) await supersedeSyntheticDefectPhoto(photoDigest); setPhotoDigest(undefined); setPhotoException(undefined); setDefect(false); };
  const complete = async () => { try {
    const hasOdometer = odometerMode !== "DISABLED"; let value: number | undefined;
    if (hasOdometer) { if (!/^\d{1,7}$/.test(odometer.trim())) throw new Error("Enter a whole odometer reading from 0 to 9,999,999"); value = Number(odometer); }
    if (inspectionMode !== "DISABLED") { const draftId = await saveSyntheticEvidence("INSPECTION", JSON.stringify({ policy: "inspection-synthetic-v2", effectivePolicyDigest: state.effectivePolicy?.canonicalDigest, stage, answers, ...(value !== undefined ? { odometer: value } : {}), ...(hasOdometer ? { fuel } : {}) })); await queueSyntheticEvidence(draftId); }
    await dispatch(stage === "PRE" ? { type: "COMPLETE_PRECHECK", ...(value !== undefined ? { odometer: value, fuelLevel: fuel } : {}) } : { type: "COMPLETE_POSTCHECK", ...(value !== undefined ? { odometer: value, fuelLevel: fuel } : {}) }); router.replace(stage === "PRE" ? "/" : "/return");
  } catch (cause) { setMessage(cause instanceof Error ? cause.message.replaceAll("_", " ") : "Could not complete the inspection"); } };
  const skipOptional = async () => { try { const skip = [...(inspectionMode === "OPTIONAL" ? ["INSPECTION" as const] : []), ...(odometerMode === "OPTIONAL" ? ["ODOMETER" as const] : [])]; if (skip.length === 0 || inspectionMode === "REQUIRED" || odometerMode === "REQUIRED") throw new Error("A required control cannot be skipped"); await dispatch(stage === "PRE" ? { type: "COMPLETE_PRECHECK", skip, reason: "OPTIONAL_CONTROL_SKIPPED" } : { type: "COMPLETE_POSTCHECK", skip, reason: "OPTIONAL_CONTROL_SKIPPED" }); router.replace(stage === "PRE" ? "/" : "/return"); } catch (cause) { setMessage(cause instanceof Error ? cause.message.replaceAll("_", " ") : "Could not skip optional controls"); } };
  if (stage === "PRE" && state.phase === "READY") return <FeasibilityScreen title="Vehicle confirmed" summary="The pinned policy assigned no pre-trip checklist or starting odometer gate for this shift."><PrimaryButton label="Continue to today's route" onPress={() => router.replace("/")} /></FeasibilityScreen>;
  return <FeasibilityScreen title={stage === "PRE" ? "Pre-trip vehicle controls" : "Post-trip vehicle controls"} summary="The server-pinned policy marks each control required, optional, or disabled. Park before using this form.">
    {state.effectivePolicy ? <StatusCard title={`${state.effectivePolicy.commercialTier.replaceAll("_", " ")} · ${state.effectivePolicy.workforceRelationship.replaceAll("_", " ")}`} status={`Checklist ${inspectionMode?.toLowerCase()} · odometer ${odometerMode?.toLowerCase()}`}><Text>These settings cannot be changed in the Driver app.</Text></StatusCard> : null}
    {!state.vehicleConfirmed && stage === "PRE" ? <><StatusCard title="Assigned vehicle" status="Synthetic Van 12" /><PrimaryButton label="Confirm this vehicle" onPress={() => dispatch({ type: "CONFIRM_VEHICLE" })} /></> : null}
    {inspectionMode !== "DISABLED" ? <><StatusCard title={`Item ${index + 1} of ${INSPECTION_ITEMS.length}`} status={item}><Text>{answered} of {INSPECTION_ITEMS.length} responses saved</Text>{answers[item] ? <Text>Saved response: {answers[item]!.response.replaceAll("_", " ")}</Text> : null}</StatusCard>
    {!defect ? <View style={styles.group}><PrimaryButton label="No defect" onPress={() => save({ response: "NO_DEFECT" })} /><PrimaryButton label="Defect found" onPress={() => setDefect(true)} /><PrimaryButton label="Not applicable" onPress={() => save({ response: "NOT_APPLICABLE" })} /></View> : <View style={styles.group}>
      <StatusCard title="Photo safety" status="Keep people and private information out"><Text>Do not photograph people, paperwork, labels, screens, or anything containing PHI.</Text></StatusCard>
      <Text accessibilityRole="header" style={styles.label}>Severity</Text>
      {(["CRITICAL_OUT_OF_SERVICE", "SERVICE_AFFECTING", "MINOR"] as const).map((value) => <PrimaryButton key={value} label={value.replaceAll("_", " ")} disabled={severity === value} onPress={() => setSeverity(value)} />)}
      <TextInput accessibilityLabel="Defect note" multiline placeholder="Describe the synthetic defect" value={note} onChangeText={setNote} style={styles.input} />
      {cameraOpen ? <><CameraView ref={camera} active facing="back" mode="picture" style={styles.camera} /><PrimaryButton label="Take synthetic defect photo" busyLabel="Protecting photo…" onPress={takePhoto} /><PrimaryButton label="Cancel camera" onPress={() => setCameraOpen(false)} /></> : <PrimaryButton label={photoDigest ? "Retake synthetic defect photo" : "Take synthetic defect photo"} onPress={openCamera} />}
      <Text style={styles.label}>{photoDigest ? "Photo protected on this phone. Or choose why a new photo cannot be taken:" : "If a photo is unsafe or impossible, choose a closed reason:"}</Text>
      <PrimaryButton label="Unsafe to capture photo" disabled={photoException === "UNSAFE_TO_CAPTURE"} onPress={() => usePhotoException("UNSAFE_TO_CAPTURE")} />
      <PrimaryButton label="Camera unavailable" disabled={photoException === "CAMERA_UNAVAILABLE"} onPress={() => usePhotoException("CAMERA_UNAVAILABLE")} />
      <PrimaryButton label="Save defect" onPress={() => save({ response: "DEFECT_FOUND", severity, note, ...(photoDigest ? { photoDigest } : {}), ...(photoException ? { photoException } : {}) })} /><PrimaryButton label="Cancel defect" onPress={cancelDefect} />
    </View>}
    <View style={styles.row}><PrimaryButton label="Previous item" disabled={index === 0} onPress={() => setIndex(index - 1)} /><PrimaryButton label="Next item" disabled={index === INSPECTION_ITEMS.length - 1} onPress={() => setIndex(index + 1)} /></View></> : <StatusCard title="Vehicle checklist" status="Not assigned"><Text>No inspection record will be fabricated.</Text></StatusCard>}
    {odometerMode !== "DISABLED" ? <><Text style={styles.label}>{stage === "PRE" ? "Starting" : "Ending"} odometer</Text><TextInput accessibilityLabel={`${stage === "PRE" ? "Starting" : "Ending"} odometer`} keyboardType="number-pad" inputMode="numeric" placeholder="Whole miles, for example 10420" value={odometer} onChangeText={setOdometer} style={styles.input} />
    <Text style={styles.label}>Fuel or charge level</Text>{(["EMPTY", "QUARTER", "HALF", "THREE_QUARTERS", "FULL"] as const).map((value) => <PrimaryButton key={value} label={value.replaceAll("_", " ")} disabled={fuel === value} onPress={() => setFuel(value)} />)}</> : <StatusCard title="Odometer" status="Not assigned"><Text>No odometer completion will be fabricated.</Text></StatusCard>}
    {message ? <StatusCard title="Vehicle check" status={message} /> : null}
    <PrimaryButton label={`Complete ${stage === "PRE" ? "pre-trip" : "post-trip"} check`} disabled={!state.vehicleConfirmed && stage === "PRE"} busyLabel="Checking your answers…" onPress={complete} />
    {(inspectionMode === "OPTIONAL" || odometerMode === "OPTIONAL") && inspectionMode !== "REQUIRED" && odometerMode !== "REQUIRED" ? <PrimaryButton label="Skip optional controls" busyLabel="Recording optional skip…" onPress={skipOptional} /> : null}
  </FeasibilityScreen>;
}
const styles = StyleSheet.create({ group: { gap: 12 }, row: { gap: 12 }, label: { color: "#15202b", fontSize: 18, fontWeight: "700" }, input: { minHeight: 52, borderWidth: 2, borderColor: "#59636e", borderRadius: 8, padding: 12, fontSize: 18, backgroundColor: "white" }, camera: { width: "100%", height: 320, borderRadius: 8, overflow: "hidden" } });
