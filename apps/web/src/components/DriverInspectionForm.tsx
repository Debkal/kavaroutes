import { useMemo, useState } from "react";
import type { DriverPrecheckRequest, DriverShiftState } from "@kavaroutes/api-contracts/client-web";

export const DRIVER_INSPECTION_ITEMS = [
  "Service and parking brakes", "Steering and suspension", "Horn", "Mirrors, cameras, and backup alarm",
  "Glass, wipers, washer, and defrost", "Lights, reflectors, signals, and hazards", "Tires, wheels, rims, lugs, and spare kit",
  "Engine, warnings, battery, fuel or charge, fluids, leaks, and exhaust", "Doors, locks, exits, steps, handrails, seats, headrests, and belts",
  "Heating, cooling, and ventilation", "Emergency, first-aid, spill, flashlight, and communication equipment",
  "Cleanliness, contamination, pests, odor, loose objects, body damage, and lost property",
  "Wheelchair lift, ramp, interlocks, manual backup, securement, tiedowns, and occupant restraints",
  "Stretcher mounts, oxygen storage, and configured specialty equipment", "Device mount, charger, navigation, and location",
  "Required vehicle documents", "Organization extension: sanitizing supplies", "Other unsafe condition",
  "Vehicle extension: configured specialty restraint", "Funding-source extension: required safety kit",
] as const;

type Item = typeof DRIVER_INSPECTION_ITEMS[number];
type Draft = { defect: boolean; severity: "CRITICAL_OUT_OF_SERVICE" | "SERVICE_AFFECTING" | "MINOR"; note: string; photo: File | null };
const initial = () => Object.fromEntries(DRIVER_INSPECTION_ITEMS.map(item => [item, { defect: false, severity: "MINOR", note: "", photo: null }])) as Record<Item, Draft>;

async function photo(file: File) {
  if (file.type !== "image/jpeg" || file.size < 100 || file.size > 150_000) throw new Error("Photos must be JPEG and no larger than 150 KB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("The selected file is not a valid JPEG photo.");
  let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const base64 = btoa(binary);
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`DEFECT_PHOTO:${base64}`)));
  return { base64, digest: [...digestBytes].map(value => value.toString(16).padStart(2, "0")).join("") };
}

export function DriverInspectionForm({ stage, shift, vehicleId, busy, onSubmit }: {
  stage: "pre" | "post"; shift: DriverShiftState; vehicleId: string; busy: boolean;
  onSubmit(request: DriverPrecheckRequest): Promise<void>;
}) {
  const [answers, setAnswers] = useState(initial);
  const [odometer, setOdometer] = useState("");
  const [fuelLevel, setFuelLevel] = useState<"EMPTY" | "QUARTER" | "HALF" | "THREE_QUARTERS" | "FULL">("FULL");
  const [skipInspection, setSkipInspection] = useState(false); const [skipOdometer, setSkipOdometer] = useState(false);
  const [message, setMessage] = useState("");
  const policy = shift.effectivePolicy;
  const inspectionMode = stage === "pre" ? policy.preInspection.mode : policy.postInspection.mode;
  const odometerMode = stage === "pre" ? policy.startOdometer.mode : policy.endOdometer.mode;
  const defects = useMemo(() => Object.values(answers).filter(answer => answer.defect).length, [answers]);
  const submit = async () => {
    setMessage("");
    try {
      const photos: { digest: string; base64: string }[] = [];
      const entries: NonNullable<Extract<DriverPrecheckRequest["inspection"], { decision: "COMPLETED" }>>["entries"][number][] = [];
      for (const item of DRIVER_INSPECTION_ITEMS) {
        if (skipInspection) break;
        const answer = answers[item];
        if (!answer.defect) { entries.push({ item, response: "NO_DEFECT" }); continue; }
        if (answer.note.trim().length < 2 || !answer.photo) throw new Error(`Add a note and JPEG photo for: ${item}`);
        const evidence = await photo(answer.photo); photos.push(evidence);
        entries.push({ item, response: "DEFECT_FOUND", severity: answer.severity, note: answer.note.trim(), photoDigest: evidence.digest });
      }
      const numeric = Number(odometer);
      if (!skipOdometer && odometerMode !== "DISABLED" && (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 9_999_999)) throw new Error("Enter a valid odometer reading.");
      const request: DriverPrecheckRequest = {
        shiftGeneration: shift.shiftGeneration, vehicleId, policyDigest: policy.canonicalDigest,
        expectedVersion: shift.resourceVersion, capturedAt: new Date().toISOString(), photos,
        ...(inspectionMode === "DISABLED" ? {} : { inspection: skipInspection ? { decision: "SKIPPED", reason: "OPTIONAL_CONTROL_SKIPPED" } : { decision: "COMPLETED", definitionVersion: "inspection-synthetic-v2", entries } }),
        ...(odometerMode === "DISABLED" ? {} : { odometer: skipOdometer ? { decision: "SKIPPED", reason: "OPTIONAL_CONTROL_SKIPPED" } : { decision: "COMPLETED", value: numeric, fuelLevel } }),
      };
      await onSubmit(request);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Vehicle check was not accepted."); }
  };
  return <section className="driver-card driver-inspection" aria-labelledby={`${stage}-inspection-title`}>
    <div className="driver-card-heading"><div><p className="driver-step">{stage === "pre" ? "Step 2" : "End of shift"}</p><h2 id={`${stage}-inspection-title`}>{stage === "pre" ? "Vehicle check before departure" : "Vehicle check after return"}</h2></div><span className="driver-pill">{defects} issue{defects === 1 ? "" : "s"}</span></div>
    <p>Mark every item. Any reported issue requires a note and a JPEG photo. Critical defects block vehicle release.</p>
    {inspectionMode === "OPTIONAL" && <label className="driver-optional"><input type="checkbox" checked={skipInspection} disabled={defects > 0} onChange={event => setSkipInspection(event.target.checked)} /> Skip optional inspection</label>}
    {inspectionMode !== "DISABLED" && !skipInspection && <div className="driver-checklist">{DRIVER_INSPECTION_ITEMS.map((item, index) => {
      const answer = answers[item];
      return <fieldset key={item} className={answer.defect ? "driver-hazard has-defect" : "driver-hazard"}>
        <legend><span>{index + 1}</span>{item}</legend>
        <div className="driver-segmented">
          <label><input type="radio" name={`${stage}-${index}`} checked={!answer.defect} onChange={() => setAnswers(current => ({ ...current, [item]: { ...current[item], defect: false, note: "", photo: null } }))} /> No issue</label>
          <label><input type="radio" name={`${stage}-${index}`} checked={answer.defect} onChange={() => setAnswers(current => ({ ...current, [item]: { ...current[item], defect: true } }))} /> Issue found</label>
        </div>
        {answer.defect && <div className="driver-defect-fields">
          <label>Severity<select value={answer.severity} onChange={event => setAnswers(current => ({ ...current, [item]: { ...current[item], severity: event.target.value as Draft["severity"] } }))}><option value="MINOR">Minor</option><option value="SERVICE_AFFECTING">Service affecting</option><option value="CRITICAL_OUT_OF_SERVICE">Critical — out of service</option></select></label>
          <label>Describe the issue<textarea maxLength={2000} value={answer.note} onChange={event => setAnswers(current => ({ ...current, [item]: { ...current[item], note: event.target.value } }))} /></label>
          <label>Photo<input type="file" accept="image/jpeg" capture="environment" onChange={event => setAnswers(current => ({ ...current, [item]: { ...current[item], photo: event.target.files?.[0] ?? null } }))} /></label>
        </div>}
      </fieldset>;
    })}</div>}
    {inspectionMode === "DISABLED" && <p className="driver-notice">Inspection is disabled by the assigned policy. Vehicle confirmation remains server-authoritative.</p>}
    {odometerMode === "OPTIONAL" && <label className="driver-optional"><input type="checkbox" checked={skipOdometer} onChange={event => setSkipOdometer(event.target.checked)} /> Skip optional odometer</label>}
    {odometerMode !== "DISABLED" && !skipOdometer && <div className="driver-form-grid"><label>{stage === "pre" ? "Starting" : "Ending"} odometer<input inputMode="numeric" pattern="[0-9]*" value={odometer} onChange={event => setOdometer(event.target.value.replace(/\D/g, ""))} /></label><label>Fuel level<select value={fuelLevel} onChange={event => setFuelLevel(event.target.value as typeof fuelLevel)}><option value="FULL">Full</option><option value="THREE_QUARTERS">¾</option><option value="HALF">½</option><option value="QUARTER">¼</option><option value="EMPTY">Empty</option></select></label></div>}
    {message && <p role="alert" className="driver-error">{message}</p>}
    <button className="driver-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Submitting…" : `Submit ${stage === "pre" ? "pre-trip" : "post-trip"} check`}</button>
  </section>;
}
