import { Text,TextInput } from "react-native";
import { useRouter } from "expo-router";
import type { DriverActionBatch } from "@kavaroutes/api-contracts/client-web";
import type { DriverItinerary } from "@kavaroutes/api-contracts/client-web";
import { FeasibilityScreen } from "./FeasibilityScreen";
import { StatusCard } from "./StatusCard";
import { PrimaryButton } from "./PrimaryButton";
import { useState } from "react";

export function CloudStopDetails({ reference, itinerary, moving, action, sync,review }: {
  reference: string | undefined; itinerary: DriverItinerary | null; moving: boolean;
  action?: (legId: string, command: DriverActionBatch["items"][number]["command"],details?: Record<string,unknown>) => Promise<void>; sync?: () => Promise<void>;review?: ()=>Promise<void>;
}) {
  const [message, setMessage] = useState("");const [note,setNote]=useState("");const router=useRouter();
  if (moving) return <FeasibilityScreen title="Stop details locked while moving" summary="Park before reviewing the itinerary." />;
  // Resolve only against the authenticated driver's current server projection.
  const leg = itinerary?.legs.find(item => item.tripLegId === reference);
  if (!leg) return <FeasibilityScreen title="Stop unavailable" summary="This leg is not in your current cloud itinerary. Refresh your assignments." />;
  const time = (value: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: leg.serviceTimezone, hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
  const e=leg.execution,c=e?.serviceControl,p=c?.proofRule;
  let next: {label: string;command: DriverActionBatch["items"][number]["command"];details?: Record<string,unknown>}|undefined;
  let signature: "PICKUP_ATTESTATION"|"DROPOFF_ATTESTATION"|undefined;
  if(!c?.incidentOpen) {
    if(e?.lifecycle==="DISPATCHED")next={label:"Start pickup route",command:"MARK_EN_ROUTE"};
    if(e?.lifecycle==="EN_ROUTE_PICKUP")next={label:"Arrived at pickup",command:"ARRIVE_PICKUP"};
    if(e?.lifecycle==="ARRIVED_PICKUP" && p && c) {
      if(!c.riderVerified)next={label:"Confirm rider identity with rider",command:"VERIFY_RIDER",details:{verificationMethod:"NAME_CONFIRMED_WITH_RIDER"}};
      else if(!c.boardingSecure)next={label:p.rule.mobilitySecurementRequired ? "Confirm rider restraints and mobility securement" : "Confirm rider is boarded and restrained",command:"SECURE_RIDER",details:{occupantRestraint:"SECURED",mobilityDevice:p.rule.mobilitySecurementRequired ? "SECURED" : "NOT_APPLICABLE"}};
      else if(p.rule.pickupRequired && !c.pickupEvidenceId)signature="PICKUP_ATTESTATION";
      else next={label:"Start Transporting",command:"BOARD_RIDER"};
    }
    if(e?.lifecycle==="ONBOARD")next={label:"Arrived at drop-off",command:"ARRIVE_DROPOFF"};
    if(e?.lifecycle==="ARRIVED_DROPOFF" && p && c) {
      if(!c.safelyUnloaded)next={label:"Confirm rider unloaded and assisted safely",command:"UNLOAD_RIDER",details:{attestation:"UNLOADED_AND_ASSISTED"}};
      else if(p.rule.dropoffRequired && !c.dropoffEvidenceId)signature="DROPOFF_ATTESTATION";
      else next={label:"Complete this leg",command:"COMPLETE_LEG"};
    }
  }
  const submit=async(command: DriverActionBatch["items"][number]["command"],details?: Record<string,unknown>)=>{
    try {if(details)await action?.(leg.tripLegId,command,details);else await action?.(leg.tripLegId,command);setMessage("");}catch(cause){setMessage(cause instanceof Error ? cause.message.replaceAll("_"," "):"No trip acceptance was recorded");}
  };
  return <FeasibilityScreen title="Assigned trip details" summary={`${itinerary!.serviceDate} · ${leg.serviceTimezone}`}>
    <StatusCard title={leg.riderLabel} status={leg.runLifecycle.replaceAll("_", " ")}>
      <Text>{leg.vehicleLabel ?? "Vehicle pending"}</Text>
    </StatusCard>
    <StatusCard title="Pickup" status={time(leg.plannedStartAt)}><Text>{leg.pickupLabel}</Text></StatusCard>
    <StatusCard title="Drop-off" status={time(leg.plannedEndAt)}><Text>{leg.dropoffLabel}</Text></StatusCard>
    <StatusCard title="Server trip progress" status={leg.execution?.lifecycle.replaceAll("_", " ") ?? "Execution not available"}>
      <Text>{leg.execution ? `Recorded version ${leg.execution.version}` : "No execution state was returned. Assignment alone does not confirm trip progress."}</Text>
    </StatusCard>
    {action && e?.expectedTag && next ? <PrimaryButton label={next.label} onPress={()=>submit(next!.command,next!.details)} /> : null}
    {signature ? <PrimaryButton label={signature==="PICKUP_ATTESTATION" ? "Capture pickup signature" : "Capture drop-off signature"} onPress={()=>router.push({pathname:"/signature",params:{leg:leg.tripLegId,event:signature}})} /> : null}
    {e && !p && !["DISPATCHED","EN_ROUTE_PICKUP"].includes(e.lifecycle) ? <StatusCard title="Proof rules unavailable" status="Dispatch must resolve the applicable service-proof rules. No tier fallback." /> : null}
    {c?.incidentOpen || e?.lifecycle==="INTERRUPTED" ? <StatusCard title="Incident requires dispatch" status="Transport and completion are blocked pending recovery review." /> : null}
    {e?.lifecycle==="COMPLETED" ? <StatusCard title="Leg complete" status="Service execution recorded; billing and evidence verification remain separate." /> : null}
    {action && e && ["DISPATCHED","EN_ROUTE_PICKUP","ARRIVED_PICKUP","ONBOARD","ARRIVED_DROPOFF"].includes(e.lifecycle) && !c?.incidentOpen ? <>
      <TextInput accessibilityLabel="Synthetic incident note" value={note} onChangeText={setNote} maxLength={1000} placeholder="Synthetic issue only — no patient data" />
      <PrimaryButton label="Report safety incident to dispatch" disabled={note.trim().length<2} onPress={()=>submit("REPORT_INCIDENT",{incidentKind:"OTHER",note:note.trim()})} />
      {["DISPATCHED","EN_ROUTE_PICKUP","ARRIVED_PICKUP"].includes(e.lifecycle) ? <PrimaryButton label="Request cancellation — rider requested" onPress={()=>submit("REQUEST_CANCEL_LEG",{reason:"RIDER_REQUESTED"})} /> : null}
      {e.lifecycle==="ARRIVED_PICKUP" && p?.rule.noShowAllowed && p.rule.noShowAuthorizationReference && !c?.boardingSecure ? <PrimaryButton label={`Record no-show after ${p.rule.noShowWaitMinutes} minutes and attempted contact`} onPress={()=>submit("MARK_RIDER_NO_SHOW",{contactAttestation:"ATTEMPTED_NO_RESPONSE",authorizationReference:p.rule.noShowAuthorizationReference})} /> : null}
    </> : null}
    {sync ? <PrimaryButton label="Recover saved trip submission" onPress={async () => { try { await sync(); setMessage(""); } catch { setMessage("Saved trip command needs recovery or review; no completion was inferred."); } }} /> : null}
    {message ? <StatusCard title="Trip submission" status={message} /> : null}
    {review ? <PrimaryButton label="Review recorded rejection and refresh before correction" onPress={async()=>{try{await review();setMessage("");}catch{setMessage("Pending command or shift authorization still needs recovery; rejection retained.");}}} /> : null}
    <PrimaryButton label="Directions availability" onPress={()=>setMessage("Google route guidance remains provider-gated. No rider information is sent and no trip state is inferred.")} />
  </FeasibilityScreen>;
}
