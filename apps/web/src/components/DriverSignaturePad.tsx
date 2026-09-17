import { useRef, useState, type PointerEvent } from "react";
import type { DriverSignatureRequest } from "@kavaroutes/api-contracts/client-web";
import type { DriverLeg } from "../cloud-driver-api";

type Point = readonly [number, number];
function bytesToHex(value: ArrayBuffer) { return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function signatureInput(shiftReference: string, legReference: string, request: Omit<DriverSignatureRequest, "digest">) {
  return JSON.stringify({ shiftReference, tripLegId: legReference, shiftGeneration: request.shiftGeneration, evidenceId: request.evidenceId,
    expectedTag: request.expectedTag, event: request.event, attestationPolicyVersion: request.attestationPolicyVersion,
    policyVersion: request.policyVersion, policyDigest: request.policyDigest, capturedAt: request.capturedAt, localActionAt: request.localActionAt,
    installationGeneration: request.installationGeneration, parkedAttestation: request.parkedAttestation, role: request.role, points: request.points,
    ...(request.unableReason ? { unableReason: request.unableReason } : {}), ...(request.witnessAttestation ? { witnessAttestation: request.witnessAttestation } : {}),
    ...(request.supersedesEvidenceId ? { supersedesEvidenceId: request.supersedesEvidenceId } : {}) });
}

export function DriverSignaturePad({ leg, shiftReference, shiftGeneration, event, busy, onSubmit }: {
  leg: DriverLeg; shiftReference: string; shiftGeneration: string; event: "PICKUP_ATTESTATION" | "DROPOFF_ATTESTATION"; busy: boolean;
  onSubmit(request: DriverSignatureRequest): Promise<void>;
}) {
  const policy = leg.execution?.serviceControl?.proofRule;
  const [points, setPoints] = useState<Point[]>([]);
  const [role, setRole] = useState<DriverSignatureRequest["role"]>(policy?.rule.allowedRoles[0] ?? "RIDER");
  const [unableReason, setUnableReason] = useState<"DECLINED" | "PHYSICALLY_UNABLE" | "NO_AUTHORIZED_SIGNER">(policy?.rule.unableReasons[0] ?? "PHYSICALLY_UNABLE");
  const [witness, setWitness] = useState(""); const [message, setMessage] = useState(""); const drawing = useRef(false);
  if (!policy || !leg.execution?.expectedTag) return <p role="alert" className="driver-error">Proof rules are unavailable. Dispatch must resolve them before signature capture.</p>;
  const add = (eventValue: PointerEvent<SVGSVGElement>) => {
    if (!drawing.current || points.length >= 600) return;
    const box = eventValue.currentTarget.getBoundingClientRect();
    const point: Point = [Math.max(0, Math.min(2048, Math.round((eventValue.clientX - box.left) / box.width * 2048))), Math.max(0, Math.min(1024, Math.round((eventValue.clientY - box.top) / box.height * 1024)))];
    setPoints(current => [...current, point]);
  };
  const submit = async () => {
    setMessage("");
    try {
      const unable = role === "RIDER_UNABLE_TO_SIGN";
      if (!unable && points.length < 8) throw new Error("Draw a fuller signature with your finger.");
      if (unable && witness.trim().length < 2) throw new Error("Enter the Driver witness attestation.");
      const now = new Date().toISOString();
      const unsigned: Omit<DriverSignatureRequest, "digest"> = {
        shiftGeneration, evidenceId: crypto.randomUUID(), expectedTag: leg.execution!.expectedTag!, event,
        attestationPolicyVersion: "attestation-synthetic-v2", policyVersion: policy.version, policyDigest: policy.digest,
        capturedAt: now, localActionAt: now, installationGeneration: "inst_webprototype0001", parkedAttestation: true,
        role, points: unable ? [] : points,
        ...(unable ? { unableReason, witnessAttestation: witness.trim() } : {}),
        ...(event === "PICKUP_ATTESTATION" && leg.execution?.serviceControl?.pickupEvidenceId ? { supersedesEvidenceId: leg.execution.serviceControl.pickupEvidenceId } : {}),
        ...(event === "DROPOFF_ATTESTATION" && leg.execution?.serviceControl?.dropoffEvidenceId ? { supersedesEvidenceId: leg.execution.serviceControl.dropoffEvidenceId } : {}),
      };
      const digest = bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`SIGNATURE:${signatureInput(shiftReference, leg.tripLegId, unsigned)}`)));
      await onSubmit({ ...unsigned, digest });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Signature was not accepted."); }
  };
  return <section className="driver-signature" aria-label={`${event === "PICKUP_ATTESTATION" ? "Pickup" : "Drop-off"} signature`}>
    <h3>{event === "PICKUP_ATTESTATION" ? "Pickup" : "Drop-off"} signature</h3>
    <label>Signer role<select value={role} onChange={eventValue => { setRole(eventValue.target.value as typeof role); setPoints([]); }}>
      {policy.rule.allowedRoles.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
    {role === "RIDER_UNABLE_TO_SIGN" ? <div className="driver-form-grid"><label>Reason<select value={unableReason} onChange={eventValue => setUnableReason(eventValue.target.value as typeof unableReason)}>{policy.rule.unableReasons.map(value => <option key={value}>{value}</option>)}</select></label><label>Driver witness attestation<input value={witness} maxLength={128} onChange={eventValue => setWitness(eventValue.target.value)} /></label></div> : <>
      <p>Ask the signer to draw inside the box with a finger.</p>
      <svg className="driver-signature-canvas" viewBox="0 0 2048 1024" role="img" aria-label="Signature drawing area"
        onPointerDown={eventValue => { drawing.current = true; eventValue.currentTarget.setPointerCapture(eventValue.pointerId); add(eventValue); }}
        onPointerMove={add} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }}>
        <polyline points={points.map(point => point.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <button className="driver-secondary" disabled={busy || !points.length} onClick={() => setPoints([])}>Clear and redraw</button>
    </>}
    {message && <p role="alert" className="driver-error">{message}</p>}
    <button className="driver-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save signature"}</button>
  </section>;
}
