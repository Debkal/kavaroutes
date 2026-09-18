import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DriverActionItem, DriverClosureView, DriverItinerary, DriverShiftState, DriverSignatureRequest } from "@kavaroutes/api-contracts/client-web";
import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";
import { createCloudDriverWebApi, type DriverCommand, type DriverLeg } from "../cloud-driver-api";
import { DriverInspectionForm } from "../components/DriverInspectionForm";
import { DriverLoginPanel } from "../components/DriverLoginPanel";
import { DriverSignaturePad } from "../components/DriverSignaturePad";
import {businessToday} from "../business-time";
import {ServiceDatePicker} from "../components/ServiceDatePicker";
import {LocationSharingPanel} from "../components/LocationSharingPanel";
import {useLocationSharing} from "../use-location-sharing";


/** Name the failure the server actually reported. The transport keeps a refused
 * command generic on purpose, so this maps the codes the driver surface can receive
 * onto the action the driver has to take. */
function failureText(error: unknown, fallback: string): string {
  const code = error instanceof DevelopmentApiError ? error.code : error instanceof Error ? error.message : "";
  switch (code) {
    case "DRIVER_LOGIN_REQUIRED":
      return "Verify your driver login above before starting a shift.";
    case "DRIVER_LOGIN_MISMATCH":
      return "That driver login belongs to another driver.";
    case "SIGNATURE_STROKE_REUSED":
      return "That signature mark was already used on another proof. Draw a different mark.";
    case "SIGNATURE_ALREADY_RECORDED":
      return "A different signature is already recorded for this event. Refresh and review.";
    case "PERSISTENCE_SHIFT_OPEN":
      return "This driver already has an open shift from an earlier service day. Open that service date, sign in and sign off, then start this shift.";
    case "PERSISTENCE_STALE_VERSION": case "VERSION_CONFLICT":
      return "This trip changed on the server. Refresh and review before continuing.";
    case "SERVICE_PROOF_ORDER_REQUIRED":
      return "The server records the physical controls before a signature. Verify and secure the rider, then collect the signature.";
    case "RIDER_VERIFICATION_REQUIRED":
      return "Verify the rider before boarding.";
    case "BOARDING_CONTROLS_REQUIRED":
      return "Secure the rider before boarding.";
    case "MOBILITY_SECUREMENT_REQUIRED":
      return "Record the mobility securement before continuing.";
    case "PICKUP_PROOF_REQUIRED":
      return "The required pickup signature is missing. Collect it before boarding.";
    case "DROPOFF_PROOF_REQUIRED":
      return "The required drop-off signature is missing. Collect it before finishing the trip.";
    case "OUTCOME_UNKNOWN":
      return "Outcome unknown. Retry the same action; it does not create a replacement.";
    default:
      return code ? `${code.replaceAll("_", " ").toLowerCase()}${error instanceof DevelopmentApiError && error.requestId ? ` (server reference ${error.requestId})` : ""}` : fallback;
  }
}

const terminal = new Set(["COMPLETED", "RIDER_NO_SHOW", "CANCELLED"]);
// Prototype retry identity is memory-only. Browser persistence remains prohibited.
const prototypeKeys = new Map<string, string>();
const savedKey = (name: string) => {
  const prior = prototypeKeys.get(name); if (prior) return prior;
  const value = `driver-web-${crypto.randomUUID()}`; prototypeKeys.set(name, value); return value;
};
const time = (value: string, zone: string) => new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
const label = (value: string) => value.toLowerCase().replaceAll("_", " ").replace(/^./, character => character.toUpperCase());

export type DriverWorkflow = "PICKUP_COMPLETE" | "DROPOFF_COMPLETE" | "PICKUP_CONTROLS" | "DROPOFF_CONTROLS";

export function nextControl(leg: DriverLeg): { label: string; command?: DriverCommand; details?: Record<string, unknown>; signature?: "PICKUP_ATTESTATION" | "DROPOFF_ATTESTATION"; workflow?: DriverWorkflow } | null {
  const execution = leg.execution; const control = execution?.serviceControl; const proof = control?.proofRule;
  if (!execution || control?.incidentOpen) return null;
  if (execution.lifecycle === "DISPATCHED") return { label: "Start route to pickup", command: "MARK_EN_ROUTE" };
  if (execution.lifecycle === "EN_ROUTE_PICKUP") return { label: "I arrived at the pickup", workflow: "PICKUP_COMPLETE" };
  if (execution.lifecycle === "ARRIVED_PICKUP" && proof && control) {
    // The server attests a pickup signature only after the physical controls are
    // recorded (riderVerified and boardingSecure), and it refuses boarding without
    // the signature when the proof rule requires one. Offer exactly that order, so
    // the operator is never asked for evidence the server will reject.
    if (!control.riderVerified || !control.boardingSecure) return { label: "Verify and secure the rider", workflow: "PICKUP_CONTROLS" };
    if (proof.rule.pickupRequired && !control.pickupEvidenceId) return { label: "Collect pickup signature", signature: "PICKUP_ATTESTATION" };
    return { label: "Board the rider", workflow: "PICKUP_COMPLETE" };
  }
  if (execution.lifecycle === "ONBOARD") return { label: "I dropped off the client at this location", workflow: "DROPOFF_COMPLETE" };
  if (execution.lifecycle === "ARRIVED_DROPOFF" && proof && control) {
    if (!control.safelyUnloaded) return { label: "Unload the rider", workflow: "DROPOFF_CONTROLS" };
    if (proof.rule.dropoffRequired && !control.dropoffEvidenceId) return { label: "Collect drop-off signature", signature: "DROPOFF_ATTESTATION" };
    return { label: "Finish this trip", workflow: "DROPOFF_COMPLETE" };
  }
  return null;
}

function blockedControlMessage(leg: DriverLeg): string {
  const execution = leg.execution;
  if (!execution) return "Dispatch has not prepared this trip for Driver execution. Contact dispatch before continuing.";
  if (execution.serviceControl?.incidentOpen) return "Dispatch review is required before this trip can continue.";
  if (["ARRIVED_PICKUP", "ONBOARD", "ARRIVED_DROPOFF"].includes(execution.lifecycle) && !execution.serviceControl?.proofRule) {
    return "This trip is missing its pickup and drop-off verification rules. Do not continue transport; contact dispatch to correct the trip setup.";
  }
  return `Trip status “${label(execution.lifecycle)}” has no available Driver action. Refresh once; if it remains unchanged, contact dispatch.`;
}

export function Component() {
  const api = useMemo(() => createCloudDriverWebApi(window.location.origin, window.fetch.bind(window)), []);
  const [serviceDate, setServiceDate] = useState(()=>businessToday());
  const [itinerary, setItinerary] = useState<DriverItinerary | null>(null);
  const [shift, setShift] = useState<DriverShiftState | null>(null);
  const [closure, setClosure] = useState<DriverClosureView | null>(null);
  const [selectedLeg, setSelectedLeg] = useState<string | null>(null);
  const [signatureEvent, setSignatureEvent] = useState<"PICKUP_ATTESTATION" | "DROPOFF_ATTESTATION" | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [signedIn, setSignedIn] = useState(false);
  const [verifiedLogin,setVerifiedLogin]=useState<{driverId:string;loginId:string}|null>(null);
  const assignmentId = shift?.effectivePolicy.assignmentId;
  const refresh = useCallback(async (selectedAssignment = assignmentId) => {
    if (!selectedAssignment) return;
    const [manifest, state] = await Promise.all([api.itinerary(serviceDate), api.shift(selectedAssignment)]);
    setItinerary(manifest.value); setShift(state.value);
    const status = await api.closure(state.value.shiftReference); setClosure(status.value);
    const unfinished = manifest.value.legs.find(leg => leg.assignmentId === selectedAssignment && !terminal.has(leg.execution?.lifecycle ?? ""));
    setSelectedLeg(current => current && manifest.value.legs.some(leg => leg.tripLegId === current) ? current : unfinished?.tripLegId ?? manifest.value.legs.find(leg => leg.assignmentId === selectedAssignment)?.tripLegId ?? null);
  }, [api, assignmentId, serviceDate]);

  useEffect(() => {
    if (!signedIn || !assignmentId || shift?.lifecycle !== "ACTIVE") return;
    const timer = window.setInterval(() => void refresh(assignmentId).catch(() => setMessage("Live status is temporarily unavailable. Previously loaded information may be stale.")), 10_000);
    return () => window.clearInterval(timer);
  }, [assignmentId, refresh, shift?.lifecycle, signedIn]);

  // Location is a condition of the shift: the browser is asked when the driver signs in,
  // a refusal fails that sign-in, and the feed is watched for the whole open shift
  // (audit L12). The device id is per tab and never leaves this surface.
  const deviceId = useMemo(() => crypto.randomUUID(), []);
  const sharing = useLocationSharing({ target: shift ? { shiftReference: shift.shiftReference, shiftGeneration: shift.shiftGeneration, deviceId } : null, api });
  const signIn = async (login=verifiedLogin) => {
    setBusy(true); setMessage("");
    try {
      if (!(await sharing.requestSharing()))
        throw new Error("Location sharing is required to sign in. Allow location for this site, then sign in again.");
      await api.authenticate(); const manifest = (await api.itinerary(serviceDate)).value;
      const unfinished = manifest.legs.filter(item => !terminal.has(item.execution?.lifecycle ?? ""));
      if (!unfinished.length) throw new Error("No unfinished Driver assignments are available for this service date.");
      // A driver holds one open shift at a time, and that shift belongs to one
      // assignment. Resume the open shift wherever it is on this day instead of
      // starting a second one, which the server refuses as a shift conflict.
      // Resume an open shift anywhere on this day; otherwise start one for the first
      // unfinished leg that has no shift yet. A leg whose shift already ended is
      // skipped rather than reported as a dead end (audit WEB-A-029).
      let resumed: { leg: DriverLeg; state: DriverShiftState } | null = null;
      let startable: DriverLeg | null = null;
      for (const candidate of unfinished) {
        let existing: DriverShiftState | null = null;
        try { existing = (await api.shift(candidate.assignmentId)).value; }
        catch (error) {
          if (!(error instanceof DevelopmentApiError) || error.status !== 404) throw error;
        }
        if (existing && existing.lifecycle === "ACTIVE") { resumed = { leg: candidate, state: existing }; break; }
        if (!existing && !startable) startable = candidate;
      }
      const leg = resumed?.leg ?? startable;
      if (!leg) throw new Error("Every unfinished assignment on this service date already has a closed shift. Ask dispatch to plan the next run.");
      let state: DriverShiftState;
      if (resumed) state = resumed.state;
      else {
        // The server refuses a start whose credential is not ACTIVE for this driver, so
        // the claimed login is what lets the shift begin (audit WEB-A-026).
        if (!login) throw new Error("Sign in with your driver account before starting a shift.");
        if(login.driverId!==manifest.driverReference)throw new Error("This account belongs to another driver. Ask Command control to issue the correct login.");
        await api.startShift(leg, manifest.serviceDate, savedKey(`start.${leg.assignmentId}`), login.loginId);
        state = (await api.shift(leg.assignmentId)).value;
      }
      if (state.lifecycle !== "ACTIVE") throw new Error("This assigned shift has already ended or requires dispatch review.");
      setSignedIn(true); setItinerary(manifest); setShift(state); setSelectedLeg(leg.tripLegId);
      setClosure((await api.closure(state.shiftReference)).value);
      setMessage("Signed in. Command control received the shift-start event; browser tracking state is now visible.");
    } catch (error) { setMessage(failureText(error, "Driver sign-in failed.")); }
    finally { setBusy(false); }
  };

  const submitCheck = async (request: Parameters<typeof api.precheck>[1], stage: "pre" | "post") => {
    if (!shift) return; setBusy(true); setMessage("");
    try {
      const receipt = await api.precheck(shift.shiftReference, request, `driver-web-${stage}-${crypto.randomUUID()}`, stage);
      setMessage(receipt.value.vehicleState === "READY" ? `${stage === "pre" ? "Pre-trip" : "Post-trip"} vehicle check accepted.` : "Critical defect reported. Vehicle release is blocked and dispatch has been notified.");
      await refresh(shift.effectivePolicy.assignmentId);
    } catch (error) { setMessage(failureText(error, "Vehicle check failed.")); }
    finally { setBusy(false); }
  };

  const submitAction = async (leg: DriverLeg, command: DriverCommand, details?: Record<string, unknown>) => {
    if (!shift || !leg.execution?.expectedTag) return; setBusy(true); setMessage("");
    try {
      const latest = (await api.shift(shift.effectivePolicy.assignmentId)).value;
      const id = crypto.randomUUID(); const key = `driver-action-${id}`;
      const item = { clientActionId: id, deviceEpoch: 1, sequence: latest.lastActionSequence + 1, capturedAt: new Date().toISOString(),
        resourceReference: leg.tripLegId, expectedTag: leg.execution.expectedTag, idempotencyKey: key, command, ...details } as DriverActionItem;
      const result = await api.action({ deviceSessionId: savedKey("device-session").slice(-36), shiftReference: latest.shiftReference, shiftGeneration: latest.shiftGeneration, items: [item] }, `driver-batch-${id}`);
      const receipt = result.value.items[0]; if (!receipt || receipt.outcome === "REJECTED") throw new Error(receipt?.code ?? "DRIVER_ACTION_REJECTED");
      setSignatureEvent(null); setMessage(`${label(command)} accepted by dispatch.`); await refresh(latest.effectivePolicy.assignmentId);
    } catch (error) { setMessage(failureText(error, "Trip update was not accepted.")); }
    finally { setBusy(false); }
  };

  const submitWorkflow = async (leg: DriverLeg, workflow: DriverWorkflow) => {
    if (!shift) return; setBusy(true); setMessage("");
    try {
      let completionMessage = workflow === "PICKUP_COMPLETE"
        ? "Pickup confirmed. Dispatch can see that the client is onboard."
        : "Drop-off confirmed. Dispatch has the completed trip update.";
      for (let step = 0; step < 4; step += 1) {
        const latestShift = (await api.shift(shift.effectivePolicy.assignmentId)).value;
        const manifest = (await api.itinerary(serviceDate)).value;
        const latestLeg = manifest.legs.find(item => item.tripLegId === leg.tripLegId);
        const execution = latestLeg?.execution; const service = execution?.serviceControl; const proof = service?.proofRule;
        if (!latestLeg || !execution?.expectedTag || !service || !proof) throw new Error("Trip setup is incomplete. Contact dispatch before continuing.");

        let command: DriverCommand | null = null; let details: Record<string, unknown> | undefined;
        if (workflow === "PICKUP_CONTROLS") {
          if (execution.lifecycle === "EN_ROUTE_PICKUP") command = "ARRIVE_PICKUP";
          else if (execution.lifecycle !== "ARRIVED_PICKUP") throw new Error(`Rider controls cannot be recorded while the trip is ${label(execution.lifecycle)}.`);
          else if (!service.riderVerified) { command = "VERIFY_RIDER"; details = { verificationMethod: "NAME_CONFIRMED_WITH_RIDER" }; }
          else if (!service.boardingSecure) { command = "SECURE_RIDER"; details = { occupantRestraint: "SECURED", mobilityDevice: proof.rule.mobilitySecurementRequired ? "SECURED" : "NOT_APPLICABLE" }; }
          else break;
          completionMessage = proof.rule.pickupRequired && !service.pickupEvidenceId
            ? "Rider verified and secured. Collect the required pickup signature next."
            : "Rider verified and secured. Board the rider next.";
        } else if (workflow === "PICKUP_COMPLETE") {
          if (execution.lifecycle === "ONBOARD") break;
          if (execution.lifecycle === "EN_ROUTE_PICKUP") command = "ARRIVE_PICKUP";
          else if (execution.lifecycle !== "ARRIVED_PICKUP") throw new Error(`Pickup cannot be completed while the trip is ${label(execution.lifecycle)}.`);
          else if (!service.riderVerified) { command = "VERIFY_RIDER"; details = { verificationMethod: "NAME_CONFIRMED_WITH_RIDER" }; }
          else if (!service.boardingSecure) { command = "SECURE_RIDER"; details = { occupantRestraint: "SECURED", mobilityDevice: proof.rule.mobilitySecurementRequired ? "SECURED" : "NOT_APPLICABLE" }; }
          else if (proof.rule.pickupRequired && !service.pickupEvidenceId) {
            completionMessage = "Verify and secure are recorded. Collect the required pickup signature, then board the rider."; break;
          }
          else command = "BOARD_RIDER";
        } else if (workflow === "DROPOFF_CONTROLS") {
          if (execution.lifecycle === "ONBOARD") command = "ARRIVE_DROPOFF";
          else if (execution.lifecycle !== "ARRIVED_DROPOFF") throw new Error(`Unload cannot be recorded while the trip is ${label(execution.lifecycle)}.`);
          else if (!service.safelyUnloaded) { command = "UNLOAD_RIDER"; details = { attestation: "UNLOADED_AND_ASSISTED" }; }
          else break;
          completionMessage = proof.rule.dropoffRequired && !service.dropoffEvidenceId
            ? "Rider unloaded. Collect the required drop-off signature next."
            : "Rider unloaded. Finish this trip next.";
        } else {
          if (execution.lifecycle === "COMPLETED") break;
          if (execution.lifecycle === "ONBOARD") command = "ARRIVE_DROPOFF";
          else if (execution.lifecycle === "ARRIVED_DROPOFF" && !service.safelyUnloaded) { command = "UNLOAD_RIDER"; details = { attestation: "UNLOADED_AND_ASSISTED" }; }
          else if (execution.lifecycle === "ARRIVED_DROPOFF" && proof.rule.dropoffRequired && !service.dropoffEvidenceId) {
            completionMessage = "Drop-off reported to dispatch. Collect the required signature to finish the trip."; break;
          } else if (execution.lifecycle === "ARRIVED_DROPOFF") command = "COMPLETE_LEG";
          else throw new Error(`Drop-off cannot be completed while the trip is ${label(execution.lifecycle)}.`);
        }
        if (!command) break;
        const id = crypto.randomUUID();
        const item = { clientActionId: id, deviceEpoch: 1, sequence: latestShift.lastActionSequence + 1, capturedAt: new Date().toISOString(), resourceReference: latestLeg.tripLegId,
          expectedTag: execution.expectedTag, idempotencyKey: `driver-action-${id}`, command, ...details } as DriverActionItem;
        const result = await api.action({ deviceSessionId: savedKey("device-session").slice(-36), shiftReference: latestShift.shiftReference, shiftGeneration: latestShift.shiftGeneration, items: [item] }, `driver-batch-${id}`);
        const receipt = result.value.items[0]; if (!receipt || receipt.outcome === "REJECTED") throw new Error(receipt?.code ?? "DRIVER_ACTION_REJECTED");
      }
      setSignatureEvent(null);
      setMessage(completionMessage);
      await refresh(shift.effectivePolicy.assignmentId);
    } catch (error) { setMessage(failureText(error, "Trip update was not accepted.")); }
    finally { setBusy(false); }
  };

  const submitSignature = async (leg: DriverLeg, request: DriverSignatureRequest) => {
    if (!shift) return; setBusy(true); setMessage("");
    try { await api.signature(shift.shiftReference, leg.tripLegId, request, `driver-signature-${request.evidenceId}`); setSignatureEvent(null); setMessage("Signature accepted for this trip event."); await refresh(shift.effectivePolicy.assignmentId); }
    catch (error) {
      // An interrupted or repeated submit may already be recorded on the server. Re-read
      // before reporting a failure, so the driver is not told to retry work that is
      // stored (audit WEB-A-022).
      try {
        const manifest = (await api.itinerary(serviceDate)).value;
        const current = manifest.legs.find(item => item.tripLegId === leg.tripLegId);
        const evidence = request.event === "PICKUP_ATTESTATION" ? current?.execution?.serviceControl?.pickupEvidenceId : current?.execution?.serviceControl?.dropoffEvidenceId;
        if (evidence) { setSignatureEvent(null); setMessage("The server already recorded this signature. Continuing."); await refresh(shift.effectivePolicy.assignmentId); return; }
      } catch { /* fall through to the refusal text */ }
      setMessage(failureText(error, "Signature was not accepted."));
    }
    finally { setBusy(false); }
  };

  const signOff = async () => {
    if (!shift) return; setBusy(true); setMessage("");
    try {
      let current = (await api.closure(shift.shiftReference)).value;
      if (current.returnMode !== "DISABLED") {
        const sampleId = crypto.randomUUID();
        await api.location(shift.shiftReference, { shiftGeneration: shift.shiftGeneration, samples: [{ sampleId, sequence: (current.sample?.sequence ?? 0) + 1, fixture: "AT_RETURN", capturedAt: new Date().toISOString() }] }, `driver-return-${sampleId}`);
        current = (await api.closure(shift.shiftReference)).value;
      }
      const commandId = crypto.randomUUID();
      const result = await api.close(shift.shiftReference, { commandId, shiftGeneration: shift.shiftGeneration, expectedVersion: current.resourceVersion,
        kind: "SIGN_OFF", reason: "NORMAL_SIGN_OFF", parkedAttestation: true, ...(current.sample ? { sampleId: current.sample.sampleId } : {}) }, `driver-signoff-${commandId}`);
      setMessage(result.value.lifecycle === "SHIFT_ENDED" ? "Signed off. Tracking collection is stopped and Command control has the final receipt." : "Return exception sent to dispatch for separate review.");
      // The shift is what the feed belongs to: closure ends it, an exception review does not.
      if (result.value.lifecycle === "SHIFT_ENDED") sharing.stopSharing("SHIFT_ENDED");
      await refresh(shift.effectivePolicy.assignmentId);
    } catch (error) { setMessage(failureText(error, "Sign-off was not accepted.")); }
    finally { setBusy(false); }
  };

  const emergencyStop = async () => {
    if (!shift) return; setBusy(true);
    try { const current = (await api.closure(shift.shiftReference)).value; const commandId = crypto.randomUUID(); await api.close(shift.shiftReference,
      { commandId, shiftGeneration: shift.shiftGeneration, expectedVersion: current.resourceVersion, kind: "EMERGENCY_STOP", reason: "SAFETY", parkedAttestation: false }, `driver-emergency-${commandId}`);
      setMessage("Emergency stop recorded. Browser tracking is stopped; contact dispatch for next steps.");
      sharing.stopSharing("EMERGENCY_STOP");
      await refresh(shift.effectivePolicy.assignmentId);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Collection stopped locally; dispatch notification needs recovery."); }
    finally { setBusy(false); }
  };

  // A recorded exception already covers this shift; pressing sign-off again only adds
  // duplicate RETURN_EXCEPTION rows and makes the reviewer's override look rejected
  // (audit WEB-A-013).
  const returnExceptionRecorded = !!closure && closure.lifecycle !== "SHIFT_ENDED" && closure.returnResult !== null && closure.returnResult !== "NOT_REQUIRED" && closure.returnResult !== "OVERRIDDEN";
  const identity = useQuery({queryKey:["driver","identity",serviceDate],queryFn:({signal})=>api.itinerary(serviceDate,signal),retry:false,enabled:!signedIn});
  // The verified login identifies the driver *and* carries the login id the start
  // command must present; the driver id alone is refused by the server (audit WEB-A-029).
  if (!signedIn || !itinerary || !shift) return <main id="main-content" className="driver-shell">
    <section className="driver-welcome"><p className="driver-step">KavaRoutes Driver</p><h1>Start your driving day</h1><p>Sign in, confirm your vehicle, follow today’s itinerary, collect required signatures, and sign off.</p>
      <ServiceDatePicker value={serviceDate} onChange={setServiceDate} disabled={busy}/>
      {message && <p role="alert" className="driver-error">{message}</p>}
      <DriverLoginPanel api={api} driverReference={identity.data?.value.driverReference ?? null} onVerified={(driverId,loginId)=>{const login={driverId,loginId};setVerifiedLogin(login);void signIn(login);}}/>
      {verifiedLogin&&busy&&<p role="status">Login verified. Loading your assigned work…</p>}
      <p className="driver-fineprint">Keep KavaRoutes open during your shift. Mobile browsers may pause location updates when the screen is locked.</p>
    </section>
    <LocationSharingPanel controller={sharing} busy={busy}/>
  </main>;

  const assigned = itinerary.legs.filter(leg => leg.assignmentId === shift.effectivePolicy.assignmentId).sort((a, b) => a.ordinal - b.ordinal);
  const allComplete = assigned.length > 0 && assigned.every(leg => terminal.has(leg.execution?.lifecycle ?? ""));
  const active = assigned.find(leg => leg.tripLegId === selectedLeg) ?? assigned[0];
  const control = active ? nextControl(active) : null;
  const postRequired = shift.effectivePolicy.postInspection.mode !== "DISABLED" || shift.effectivePolicy.endOdometer.mode !== "DISABLED";
  const needsPostcheck = allComplete && postRequired && !closure?.postcheck;
  const needsPrecheck = !shift.precheck || shift.precheck.vehicleState !== "READY";

  return <main id="main-content" className="driver-shell">
    <header className="driver-mobile-header"><div><p className="driver-step">Signed in · {shift.effectivePolicy.commercialTier.replaceAll("_", " ")}</p><h1>Today’s route</h1></div><span className={closure?.tracking.contactDriver ? "driver-status warning" : "driver-status"}>{closure?.lifecycle === "SHIFT_ENDED" ? "Signed off" : "Tracking " + label(closure?.tracking.status ?? "starting")}</span></header>
    {message && <p role="status" className="driver-message">{message}</p>}
    <section className="driver-summary"><div><span>Vehicle</span><strong>{assigned[0]?.vehicleLabel ?? "Pending"}</strong></div><div><span>Trips</span><strong>{assigned.filter(leg => terminal.has(leg.execution?.lifecycle ?? "")).length}/{assigned.length}</strong></div><div><span>Updates</span><strong>{closure?.tracking.status === "UPDATES_CURRENT" ? "Live" : "Foreground"}</strong></div></section>

    {closure?.lifecycle === "SHIFT_ENDED" ? <section className="driver-card driver-complete"><p className="driver-step">Shift complete</p><h2>You’re signed off</h2><p>Command control has the final server receipt. Tracking is stopped.</p></section>
    : needsPrecheck ? <DriverInspectionForm stage="pre" shift={shift} vehicleId={assigned[0]?.vehicleId ?? ""} busy={busy} onSubmit={request => submitCheck(request, "pre")} />
    : needsPostcheck ? <DriverInspectionForm stage="post" shift={shift} vehicleId={assigned[0]?.vehicleId ?? ""} busy={busy} onSubmit={request => submitCheck(request, "post")} />
    : allComplete ? <section className="driver-card driver-return"><p className="driver-step">Final step</p><h2>Return vehicle and sign off</h2><p>Confirm you are parked at the assigned vehicle return location. Location is checked before tracking stops.</p>{returnExceptionRecorded?<p role="status">Return exception recorded and waiting on dispatch review. Do not press sign-off again; the reviewer ends the shift from that single request.</p>:null}<button className="driver-primary" disabled={busy||returnExceptionRecorded} onClick={() => void signOff()}>{busy ? "Signing off…" : returnExceptionRecorded ? "Waiting for dispatch review" : "Confirm return and sign off"}</button></section>
    : <div className="driver-workspace">
      <section className="driver-card driver-itinerary" aria-labelledby="itinerary-title"><div className="driver-card-heading"><div><p className="driver-step">Step 3</p><h2 id="itinerary-title">Daily itinerary</h2></div><span className="driver-pill">{serviceDate}</span></div>
        <ol>{assigned.map(leg => <li key={leg.tripLegId}><button className={leg.tripLegId === active?.tripLegId ? "active" : ""} onClick={() => { setSelectedLeg(leg.tripLegId); setSignatureEvent(null); }}><span className="driver-stop-number">{leg.ordinal}</span><span><strong>{leg.riderLabel}</strong><small>{time(leg.plannedStartAt, leg.serviceTimezone)} · {leg.pickupLabel} → {leg.dropoffLabel}</small></span><span className={`driver-leg-state ${terminal.has(leg.execution?.lifecycle ?? "") ? "done" : ""}`}>{label(leg.execution?.lifecycle ?? leg.runLifecycle)}</span></button></li>)}</ol>
      </section>
      {active && <section className="driver-card driver-current"><p className="driver-step">Current client · Stop {active.ordinal}</p><h2>{active.riderLabel}</h2>
        <div className="driver-route-line"><div><span>Pickup</span><strong>{active.pickupLabel}</strong><small>{time(active.plannedStartAt, active.serviceTimezone)}</small></div><div><span>Drop-off</span><strong>{active.dropoffLabel}</strong><small>{time(active.plannedEndAt, active.serviceTimezone)}</small></div></div>
        {(active.appointmentLengthMinutes??0)>0&&<p className="driver-notice">Appointment / planned wait: <strong>{active.appointmentLengthMinutes} minutes</strong></p>}
        <a className="driver-secondary driver-link" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(active.pickupLabel)}&destination=${encodeURIComponent(active.dropoffLabel)}`}>Open route in Google Maps</a>
        {!control && !terminal.has(active.execution?.lifecycle ?? "") && <p role="alert" className="driver-error">{blockedControlMessage(active)}</p>}
        {control?.signature && !signatureEvent && <button className="driver-primary" disabled={busy} onClick={() => setSignatureEvent(control.signature!)}>{control.label}</button>}
        {control?.command && <button className="driver-primary" disabled={busy} onClick={() => void submitAction(active, control.command!, control.details)}>{busy ? "Sending…" : control.label}</button>}
        {control?.workflow && <button className="driver-primary" disabled={busy} onClick={() => void submitWorkflow(active, control.workflow!)}>{busy ? "Sending update…" : control.label}</button>}
        {control && <p className="driver-fineprint">Dispatch receives each accepted status immediately. GPS proximity confirmation is not yet enabled, and reloading the tab asks you to sign in again even though the shift continues on the server.</p>}
        {signatureEvent && <DriverSignaturePad leg={active} shiftReference={shift.shiftReference} shiftGeneration={shift.shiftGeneration} event={signatureEvent} busy={busy} onSubmit={request => submitSignature(active, request)} />}
      </section>}
    </div>}
    {closure?.lifecycle !== "SHIFT_ENDED" && <aside className="driver-safety"><div><strong>Tracking transparency</strong><span>{label(closure?.tracking.status ?? "starting")} · {closure?.tracking.reason?.replaceAll("_", " ") ?? "Shift started"}</span></div><button disabled={busy} onClick={() => void emergencyStop()}>Emergency: stop sharing</button></aside>}
    <LocationSharingPanel controller={sharing} busy={busy}/>
  </main>;
}
