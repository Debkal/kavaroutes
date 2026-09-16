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
import { useInspectionDraft } from "../src/use-inspection-draft";

export default function InspectionScreen() {
  const router = useRouter(); const { state, dispatch, cloudPrototype, itinerary } = useWorkflow();
  const stage = ["POSTCHECK_REQUIRED", "POSTCHECK_OFFERED"].includes(state.phase) ? "POST" : "PRE"; const answers = stage === "PRE" ? state.preCheck : state.postCheck;
  const inspectionMode = stage === "PRE" ? state.effectivePolicy?.preInspection.mode : state.effectivePolicy?.postInspection.mode;
  const odometerMode = stage === "PRE" ? state.effectivePolicy?.startOdometer.mode : state.effectivePolicy?.endOdometer.mode;
  const firstOpen = INSPECTION_ITEMS.findIndex((item) => !answers[item]);
  const form = useInspectionDraft({ generation: state.shiftGeneration, stage, policyDigest: state.effectivePolicy?.canonicalDigest ?? "no-policy" }, {
    index: firstOpen < 0 ? INSPECTION_ITEMS.length - 1 : firstOpen,
    odometer: (stage === "PRE" ? state.startOdometer : state.endOdometer)?.toString() ?? "", fuel: state.fuelLevel ?? "FULL",
    skipInspection: false, skipOdometer: false, defect: false, severity: "MINOR", note: "", photoDigest: null, photoException: null,
  });
  const { index, odometer, fuel, skipInspection, skipOdometer, defect, severity, note } = form.draft;
  const photoDigest = form.draft.photoDigest ?? undefined; const photoException = form.draft.photoException ?? undefined;
  const setIndex = (index: number) => form.change({ index }); const setOdometer = (odometer: string) => form.change({ odometer });
  const setFuel = (fuel: typeof form.draft.fuel) => form.change({ fuel });
  const setSkipInspection = (skipInspection: boolean) => form.change({ skipInspection }); const setSkipOdometer = (skipOdometer: boolean) => form.change({ skipOdometer });
  const setDefect = (defect: boolean) => form.change({ defect }); const setSeverity = (severity: DefectSeverity) => form.change({ severity });
  const setNote = (note: string) => form.change({ note });
  const setPhotoDigest = (photoDigest?: string) => form.change({ photoDigest: photoDigest ?? null });
  const setPhotoException = (photoException?: "UNSAFE_TO_CAPTURE" | "CAMERA_UNAVAILABLE") => form.change({ photoException: photoException ?? null });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions(); const camera = useRef<CameraView>(null); const [message, setMessage] = useState("");
  const [pictureSize, setPictureSize] = useState<string>(); const [cameraReady, setCameraReady] = useState(false);
  const item = INSPECTION_ITEMS[index]!; const answered = Object.keys(answers).length;
  const save = async (answer: InspectionAnswer) => { try { await form.flush(); await dispatch({ type: "ANSWER_INSPECTION", stage, item, answer }); form.change({ defect: false, note: "", photoDigest: null, photoException: null, severity: "MINOR", index: Math.min(index + 1, INSPECTION_ITEMS.length - 1) }); await form.flush(); setMessage("Saved securely on this phone"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not save this item"); } };
  const configureCamera = async () => { try { const sizes = await camera.current?.getAvailablePictureSizesAsync(); const bounded = sizes?.filter(size => /^\d+x\d+$/.test(size)).sort((a, b) => { const area = (value: string) => value.split("x").reduce((total, n) => total * Number(n), 1); return area(a) - area(b); }); if (bounded?.[0]) setPictureSize(bounded[0]); setCameraReady(true); } catch { setMessage("Camera size could not be verified. Use a closed exception if a safe photo is impossible."); } };
  const openCamera = async () => { const result = permission?.granted ? permission : await requestPermission(); if (!result.granted) { setMessage("Camera permission was not granted. Choose a closed exception reason if a photo is unsafe or impossible."); return; } setCameraOpen(true); };
  const takePhoto = async () => { let uri: string | undefined; try { if (!cameraReady) throw new Error("Wait for the camera to be ready"); const picture = await camera.current?.takePictureAsync({ base64: true, quality: 0.35, shutterSound: true }); if (!picture?.base64) throw new Error("CAMERA_DID_NOT_RETURN_PHOTO"); uri = picture.uri; if (cloudPrototype && picture.base64.length > 200000) throw new Error("Photo is too large for this private prototype (150 KB limit). Retake at a smaller resolution; do not report a camera exception just because an upload is large."); const digest = await saveSyntheticDefectPhoto(picture.base64); if (photoDigest) await supersedeSyntheticDefectPhoto(photoDigest); setPhotoDigest(digest); setPhotoException(undefined); setCameraOpen(false); setCameraReady(false); setMessage("Synthetic defect photo encrypted and temporary camera file removed"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not protect the photo"); } finally { if (uri) { try { new File(uri).delete(); } catch { setMessage("Photo capture failed closed while removing its temporary file"); } } } };
  const usePhotoException = async (reason: "UNSAFE_TO_CAPTURE" | "CAMERA_UNAVAILABLE") => { if (photoDigest) await supersedeSyntheticDefectPhoto(photoDigest); setPhotoException(reason); setPhotoDigest(undefined); };
  const cancelDefect = async () => { if (photoDigest) await supersedeSyntheticDefectPhoto(photoDigest); setPhotoDigest(undefined); setPhotoException(undefined); setDefect(false); };
  const complete = async () => { try {
    await form.flush();
    const hasOdometer = odometerMode !== "DISABLED" && !skipOdometer; let value: number | undefined;
    if (hasOdometer) { if (!/^\d{1,7}$/.test(odometer.trim())) throw new Error("Enter a whole odometer reading from 0 to 9,999,999"); value = Number(odometer); }
    const skip = [...(skipInspection ? ["INSPECTION" as const] : []), ...(skipOdometer ? ["ODOMETER" as const] : [])];
    if (!cloudPrototype && inspectionMode !== "DISABLED" && !skipInspection) { const draftId = await saveSyntheticEvidence("INSPECTION", JSON.stringify({ policy: "inspection-synthetic-v2", effectivePolicyDigest: state.effectivePolicy?.canonicalDigest, stage, answers, ...(value !== undefined ? { odometer: value } : {}), ...(hasOdometer ? { fuel } : {}) })); await queueSyntheticEvidence(draftId); }
    const controls = { ...(value !== undefined ? { odometer: value, fuelLevel: fuel } : {}), ...(skip.length ? { skip, reason: "OPTIONAL_CONTROL_SKIPPED" as const } : {}) };
    await dispatch(stage === "PRE" ? { type: "COMPLETE_PRECHECK", ...controls } : { type: "COMPLETE_POSTCHECK", ...controls }); router.replace(stage === "PRE" ? "/" : "/return");
  } catch (cause) { setMessage(cause instanceof Error ? cause.message.replaceAll("_", " ") : "Could not complete the inspection"); } };
  const skipOptional = async () => { try { const skip = [...(inspectionMode === "OPTIONAL" ? ["INSPECTION" as const] : []), ...(odometerMode === "OPTIONAL" ? ["ODOMETER" as const] : [])]; if (skip.length === 0 || inspectionMode === "REQUIRED" || odometerMode === "REQUIRED") throw new Error("A required control cannot be skipped"); await dispatch(stage === "PRE" ? { type: "COMPLETE_PRECHECK", skip, reason: "OPTIONAL_CONTROL_SKIPPED" } : { type: "COMPLETE_POSTCHECK", skip, reason: "OPTIONAL_CONTROL_SKIPPED" }); router.replace(stage === "PRE" ? "/" : "/return"); } catch (cause) { setMessage(cause instanceof Error ? cause.message.replaceAll("_", " ") : "Could not skip optional controls"); } };
  if (state.moving) return <FeasibilityScreen title="Park to inspect the vehicle" summary="Vehicle checks, notes and photos are available when parked." />;
  if (!form.ready) return <FeasibilityScreen title="Recovering vehicle input" summary={form.error ?? "Opening the protected inspection draft."} />;
  if (stage === "PRE" && state.phase === "READY") return <FeasibilityScreen title="Vehicle confirmed" summary={cloudPrototype ? state.lastReceipt : "The assigned pre-trip controls are resolved for this shift."}><PrimaryButton label="Continue to today's route" onPress={() => router.replace("/")} /></FeasibilityScreen>;
  if (state.phase === "BLOCKED_CRITICAL_DEFECT") return <FeasibilityScreen title="Vehicle out of service" summary="The inspection reported a critical defect. Do not start trips; dispatch must resolve the vehicle issue."><StatusCard title="Vehicle decision" status={state.lastReceipt} /></FeasibilityScreen>;
  return <FeasibilityScreen title={stage === "PRE" ? "Pre-trip vehicle controls" : "Post-trip vehicle controls"} summary="The server-pinned policy marks each control required, optional, or disabled. Park before using this form.">
    {state.effectivePolicy ? <StatusCard title={`${state.effectivePolicy.commercialTier.replaceAll("_", " ")} · ${state.effectivePolicy.workforceRelationship.replaceAll("_", " ")}`} status={`Checklist ${inspectionMode?.toLowerCase()} · odometer ${odometerMode?.toLowerCase()}`}><Text>These settings cannot be changed in the Driver app.</Text></StatusCard> : null}
    {!state.vehicleConfirmed && stage === "PRE" ? <><StatusCard title="Assigned vehicle" status={cloudPrototype ? itinerary?.legs.find(leg => leg.assignmentId === state.effectivePolicy?.assignmentId)?.vehicleLabel ?? "Assigned vehicle unavailable" : "Synthetic Van 12"} /><PrimaryButton label="Confirm this vehicle" onPress={() => dispatch({ type: "CONFIRM_VEHICLE" })} /></> : null}
    {inspectionMode === "OPTIONAL" ? <PrimaryButton label={skipInspection ? "Complete optional checklist instead" : "Skip optional checklist only"} disabled={!skipInspection && Object.values(answers).some(answer => answer.response === "DEFECT_FOUND")} onPress={() => setSkipInspection(!skipInspection)} /> : null}
    {odometerMode === "OPTIONAL" ? <PrimaryButton label={skipOdometer ? "Enter optional odometer instead" : "Skip optional odometer only"} onPress={() => setSkipOdometer(!skipOdometer)} /> : null}
    {inspectionMode !== "DISABLED" && !skipInspection ? <><StatusCard title={`Item ${index + 1} of ${INSPECTION_ITEMS.length}`} status={item}><Text>{answered} of {INSPECTION_ITEMS.length} responses saved</Text>{answers[item] ? <Text>Saved response: {answers[item]!.response.replaceAll("_", " ")}</Text> : null}</StatusCard>
    {!defect ? <View style={styles.group}><PrimaryButton label="No defect" onPress={() => save({ response: "NO_DEFECT" })} /><PrimaryButton label="Defect found" onPress={() => setDefect(true)} /><PrimaryButton label="Not applicable" onPress={() => save({ response: "NOT_APPLICABLE" })} /></View> : <View style={styles.group}>
      <StatusCard title="Photo safety" status="Keep people and private information out"><Text>Do not photograph people, paperwork, labels, screens, or anything containing PHI.</Text></StatusCard>
      <Text accessibilityRole="header" style={styles.label}>Severity</Text>
      {(["CRITICAL_OUT_OF_SERVICE", "SERVICE_AFFECTING", "MINOR"] as const).map((value) => <PrimaryButton key={value} label={value.replaceAll("_", " ")} disabled={severity === value} onPress={() => setSeverity(value)} />)}
      <TextInput accessibilityLabel="Defect note" multiline placeholder="Describe the synthetic defect" value={note} onChangeText={setNote} style={styles.input} />
      {cameraOpen ? <><CameraView ref={camera} active facing="back" mode="picture" {...(pictureSize ? { pictureSize } : {})} onCameraReady={configureCamera} style={styles.camera} /><PrimaryButton label="Take synthetic defect photo" disabled={!cameraReady} busyLabel="Protecting photo…" onPress={takePhoto} /><PrimaryButton label="Cancel camera" onPress={() => { setCameraOpen(false); setCameraReady(false); }} /></> : <PrimaryButton label={photoDigest ? "Retake synthetic defect photo" : "Take synthetic defect photo"} onPress={openCamera} />}
      <Text style={styles.label}>{photoDigest ? "Photo protected on this phone. Or choose why a new photo cannot be taken:" : "If a photo is unsafe or impossible, choose a closed reason:"}</Text>
      <PrimaryButton label="Unsafe to capture photo" disabled={photoException === "UNSAFE_TO_CAPTURE"} onPress={() => usePhotoException("UNSAFE_TO_CAPTURE")} />
      <PrimaryButton label="Camera unavailable" disabled={photoException === "CAMERA_UNAVAILABLE"} onPress={() => usePhotoException("CAMERA_UNAVAILABLE")} />
      <PrimaryButton label="Save defect" onPress={() => save({ response: "DEFECT_FOUND", severity, note, ...(photoDigest ? { photoDigest } : {}), ...(photoException ? { photoException } : {}) })} /><PrimaryButton label="Cancel defect" onPress={cancelDefect} />
    </View>}
    <View style={styles.row}><PrimaryButton label="Previous item" disabled={index === 0 || defect} onPress={() => setIndex(index - 1)} /><PrimaryButton label="Next item" disabled={index === INSPECTION_ITEMS.length - 1 || defect} onPress={() => setIndex(index + 1)} /></View></> : <StatusCard title="Vehicle checklist" status={skipInspection ? "Optional skip selected — not accepted yet" : "Not assigned"}><Text>No inspection completion will be fabricated.</Text></StatusCard>}
    {odometerMode !== "DISABLED" && !skipOdometer ? <><Text style={styles.label}>{stage === "PRE" ? "Starting" : "Ending"} odometer</Text><TextInput accessibilityLabel={`${stage === "PRE" ? "Starting" : "Ending"} odometer`} keyboardType="number-pad" inputMode="numeric" placeholder="Whole miles, for example 10420" value={odometer} onChangeText={setOdometer} style={styles.input} />
    <Text style={styles.label}>Fuel or charge level</Text>{(["EMPTY", "QUARTER", "HALF", "THREE_QUARTERS", "FULL"] as const).map((value) => <PrimaryButton key={value} label={value.replaceAll("_", " ")} disabled={fuel === value} onPress={() => setFuel(value)} />)}</> : <StatusCard title="Odometer" status={skipOdometer ? "Optional skip selected — not accepted yet" : "Not assigned"}><Text>No odometer completion will be fabricated.</Text></StatusCard>}
    {form.error ? <StatusCard title="Draft storage" status={form.error} /> : null}
    {message ? <StatusCard title="Vehicle check" status={message} /> : null}
    <PrimaryButton label={`Complete ${stage === "PRE" ? "pre-trip" : "post-trip"} check`} disabled={!state.vehicleConfirmed && stage === "PRE"} busyLabel="Checking your answers…" onPress={complete} />
    {(inspectionMode === "OPTIONAL" || odometerMode === "OPTIONAL") && inspectionMode !== "REQUIRED" && odometerMode !== "REQUIRED" ? <PrimaryButton label="Skip optional controls" busyLabel="Recording optional skip…" onPress={skipOptional} /> : null}
  </FeasibilityScreen>;
}
const styles = StyleSheet.create({ group: { gap: 12 }, row: { gap: 12 }, label: { color: "#15202b", fontSize: 18, fontWeight: "700" }, input: { minHeight: 52, borderWidth: 2, borderColor: "#59636e", borderRadius: 8, padding: 12, fontSize: 18, backgroundColor: "white" }, camera: { width: "100%", height: 320, borderRadius: 8, overflow: "hidden" } });
