import { useEffect,useMemo,useRef,useState } from "react";
import { PanResponder,StyleSheet,Text,TextInput,View } from "react-native";
import { useRouter } from "expo-router";
import { randomUUID } from "expo-crypto";
import type { DriverSignatureRequest } from "@kavaroutes/api-contracts/client-web";
import { FeasibilityScreen } from "./FeasibilityScreen";
import { PrimaryButton } from "./PrimaryButton";
import { StatusCard } from "./StatusCard";
import { useWorkflow } from "../workflow-context";
import { openCloudSignatureStore } from "../nativeActions";
import { createEvidenceDigest } from "../crypto";
import { cloudSignatureDigestInput } from "../cloud-signature";
import type { SignatureDraft } from "../cloud-signature-store";

export function CloudSignatureScreen({legId,event}:{legId:string|undefined;event:string|undefined}) {
  const w=useWorkflow(),router=useRouter();const leg=w.itinerary?.legs.find(l=>l.tripLegId===legId && l.assignmentId===w.state.effectivePolicy?.assignmentId);
  const c=leg?.execution?.serviceControl,p=c?.proofRule;const shift=w.state.shiftReference;
  const [draft,setDraft]=useState<SignatureDraft>({points:[],role:"RIDER",unableReason:"PHYSICALLY_UNABLE",witness:"",policyDigest:""});
  const draftRef=useRef(draft),tail=useRef(Promise.resolve()),activeBinding=useRef("");const [ready,setReady]=useState(false),[message,setMessage]=useState("");
  const binding=`${shift}:${legId}:${event}:${p?.digest}`;
  useEffect(()=>{let active=true;activeBinding.current=binding;setReady(false);
    if(!shift || !legId || !p || !["PICKUP_ATTESTATION","DROPOFF_ATTESTATION"].includes(event ?? ""))return;
    void openCloudSignatureStore().then(async store=>{
      const saved=await store.draft(shift,legId,event!);
      const initial:SignatureDraft={points:[],role:p.rule.allowedRoles[0] as DriverSignatureRequest["role"],unableReason:"PHYSICALLY_UNABLE",witness:"",policyDigest:p.digest};
      const valid=saved && saved.policyDigest===p.digest && p.rule.allowedRoles.includes(saved.role) && Array.isArray(saved.points) && saved.points.length<=600 && saved.points.every(v=>Array.isArray(v) && v.length===2 && v.every(Number.isInteger) && v[0]>=0 && v[0]<=2048 && v[1]>=0 && v[1]<=1024) && typeof saved.witness==="string" && saved.witness.length<=128;
      if(active){draftRef.current=valid ? saved : initial;setDraft(draftRef.current);setReady(true);}
    }).catch(()=>{if(active)setMessage("Protected signature draft could not be reopened. Capture is blocked.");});
    return()=>{active=false;activeBinding.current="";};
  },[binding]);
  const change=(changes:Partial<SignatureDraft>)=>{
    if(!ready || !shift || !legId || !event || activeBinding.current!==binding)return;
    const next={...draftRef.current,...changes};draftRef.current=next;setDraft(next);
    tail.current=tail.current.then(async()=>{await (await openCloudSignatureStore()).saveDraft(shift,legId,event,next);});
    void tail.current.catch(()=>setMessage("Draft save failed. Submission is blocked; reopen protected storage."));
  };
  const readyRef=useRef(false);readyRef.current=ready;
  const changeRef=useRef(change);changeRef.current=change;
  const pan=useMemo(()=>PanResponder.create({onStartShouldSetPanResponder:()=>readyRef.current,onMoveShouldSetPanResponder:()=>readyRef.current,
    onPanResponderGrant:e=>add(e.nativeEvent.locationX,e.nativeEvent.locationY),onPanResponderMove:e=>add(e.nativeEvent.locationX,e.nativeEvent.locationY)}),[]);
  const add=(x:number,y:number)=>{if(draftRef.current.points.length>=600)return;changeRef.current({points:[...draftRef.current.points,[Math.max(0,Math.min(2048,Math.round(x))),Math.max(0,Math.min(1024,Math.round(y)))]]});};
  const orderOk=event==="PICKUP_ATTESTATION" ? leg?.execution?.lifecycle==="ARRIVED_PICKUP" && c?.riderVerified && c.boardingSecure : event==="DROPOFF_ATTESTATION" && leg?.execution?.lifecycle==="ARRIVED_DROPOFF" && c?.safelyUnloaded;
  if(w.state.moving || !shift || !leg || !p || !orderOk || c?.incidentOpen) return <FeasibilityScreen title="Signature unavailable" summary="Park and recover the assigned leg, physical controls and applicable proof rules before capture." />;
  const accept=async()=>{try{
    await tail.current;
    const current=draftRef.current;
    if(!p.rule.allowedRoles.includes(current.role))throw new Error("Signer role is not authorized by the service-proof rule.");
    const unable=current.role==="RIDER_UNABLE_TO_SIGN";
    if(unable && (!p.rule.unableReasons.includes(current.unableReason) || current.witness.trim().length<2))throw new Error("An allowed reason and witness attestation are required.");
    if(!unable && current.points.length<8)throw new Error("Draw a fuller mark inside the box.");
    const store=await openCloudSignatureStore();const pending=(await store.commands(shift)).find(s=>s.state==="PENDING");
    let request:DriverSignatureRequest;
    if(pending) {if(pending.leg!==leg.tripLegId || pending.request.event!==event)throw new Error("Recover the other pending signature first.");request=pending.request;}
    else {
      const now=new Date().toISOString(),previous=event==="PICKUP_ATTESTATION" ? c.pickupEvidenceId : c.dropoffEvidenceId;
      const unsigned:Omit<DriverSignatureRequest,"digest">={shiftGeneration:w.state.shiftGeneration,evidenceId:randomUUID(),expectedTag:leg.execution!.expectedTag!,
        event:event as DriverSignatureRequest["event"],attestationPolicyVersion:"attestation-synthetic-v2",policyVersion:p.version,policyDigest:p.digest,capturedAt:now,localActionAt:now,
        installationGeneration:"inst_synthetic0000001",parkedAttestation:true,role:current.role,points:unable ? [] : current.points,
        ...(unable ? {unableReason:current.unableReason,witnessAttestation:current.witness.trim()}:{}),...(previous ? {supersedesEvidenceId:previous}:{})};
      request={...unsigned,digest:await createEvidenceDigest(`SIGNATURE:${cloudSignatureDigestInput(shift,leg.tripLegId,unsigned)}`)};
    }
    await w.cloudSignature(leg.tripLegId,request);router.replace({pathname:"/stop/[reference]",params:{reference:leg.tripLegId}});
  }catch(cause){setMessage(cause instanceof Error ? cause.message:"Signature remains saved without acceptance.");}};
  return <FeasibilityScreen title={event==="PICKUP_ATTESTATION" ? "Pickup signature" : "Drop-off signature"} summary="Only this assigned rider and event are shown. A signature is an attestation, not identity proof or billing verification.">
    <StatusCard title={leg.riderLabel} status={event!.replaceAll("_"," ")} />
    {p.rule.allowedRoles.map(role=><PrimaryButton key={role} label={role.replaceAll("_"," ")} disabled={!ready || draft.role===role} onPress={()=>change({role:role as DriverSignatureRequest["role"]})} />)}
    {draft.role==="RIDER_UNABLE_TO_SIGN" ? <>
      {p.rule.unableReasons.map(reason=><PrimaryButton key={reason} label={reason.replaceAll("_"," ")} disabled={!ready || draft.unableReason===reason} onPress={()=>change({unableReason:reason as SignatureDraft["unableReason"],points:[]})} />)}
      <TextInput accessibilityLabel="Authorized witness attestation" placeholder="Synthetic witness attestation only" value={draft.witness} maxLength={128} onChangeText={witness=>change({witness})} />
    </> : <><Text>Draw with your finger inside the box.</Text><View accessibilityLabel="Signature drawing area" style={styles.canvas} {...pan.panHandlers}>{draft.points.map(([x,y],i)=><View key={i} style={[styles.dot,{left:x,top:y}]} />)}</View>
      <PrimaryButton label="Clear and redraw" disabled={!ready} onPress={()=>change({points:[]})} />
    </>}
    {message ? <StatusCard title="Signature submission" status={message} /> : null}
    <PrimaryButton label="Save signature for server acceptance" disabled={!ready} onPress={accept} />
    <PrimaryButton label="Recover original saved signature" onPress={async()=>{try{await w.syncCloudActions();setMessage("Server receipts refreshed. Only accepted proof permits transport or completion.");}catch{setMessage("Original submission is pending; no acceptance inferred.");}}} />
  </FeasibilityScreen>;
}
const styles=StyleSheet.create({canvas:{height:240,backgroundColor:"white",borderWidth:3,borderColor:"#334e68",overflow:"hidden"},dot:{position:"absolute",width:5,height:5,borderRadius:3,backgroundColor:"#102a43"}});
