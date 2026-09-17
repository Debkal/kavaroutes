import {useState} from "react";
import {DevelopmentApiError} from "@kavaroutes/api-contracts/private-development-transport";
import type {ClientRecord,ClientTripType,createCloudClientApi} from "../cloud-client-api";

/** Correct a client record dispatch already entered. The operator fields and the pickup
 * label are replaced; drop-offs are appended, because the recorded pattern is history. */
export function ClientEditForm({api,client,onSaved}:{api:ReturnType<typeof createCloudClientApi>;client:ClientRecord;onSaved:(version:number)=>void}){
  const [displayName,setDisplayName]=useState(client.displayName);
  const [entityName,setEntityName]=useState(client.entityName??"");
  const [phone,setPhone]=useState(client.phone??"");
  const [pickupAddress,setPickupAddress]=useState(client.pickupAddress??"");
  const [tripType,setTripType]=useState<ClientTripType>(client.tripType??"ONE_WAY");
  const [notes,setNotes]=useState(client.notes??"");
  const [additional,setAdditional]=useState("");
  const [message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const submit=async()=>{
    if(busy)return;
    const name=displayName.trim();
    if(!name||name.length>200){setMessage("Enter a client name of 1 to 200 characters.");return;}
    const add=additional.split("\n").map(value=>value.trim()).filter(Boolean);
    if(add.some(value=>value.length>512)){setMessage("Keep each drop-off address to 512 characters or fewer.");return;}
    setBusy(true);setMessage("Saving the client…");
    try{
      const receipt=await api.update(client.clientId,{displayName:name,entityName:entityName.trim()||null,phone:phone.trim()||null,
        pickupAddress:pickupAddress.trim()||null,tripType,notes:notes.trim()||null,...(add.length?{addDropoffAddresses:add}:{})},`web-client-update-${crypto.randomUUID()}`);
      setAdditional("");
      setMessage(`Client saved at version ${receipt.value.version}${receipt.value.dropoffCount?` with ${receipt.value.dropoffCount} drop-off(s) added`:""}.`);
      onSaved(receipt.value.version);
    }catch(error){
      if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500&&error.code!=="OUTCOME_UNKNOWN"){
        setMessage(`The change was rejected: ${error.code.replaceAll("_"," ").toLowerCase()}.`);
      }else setMessage("Outcome unknown. Retry the same save before making another change.");
    }finally{setBusy(false);}
  };
  return <details>
    <summary>Edit this client</summary>
    <label>Client name <input value={displayName} disabled={busy} onChange={event=>setDisplayName(event.target.value)}/></label>
    <label>Entity (optional) <input value={entityName} disabled={busy} onChange={event=>setEntityName(event.target.value)}/></label>
    <label>Phone <input value={phone} disabled={busy} onChange={event=>setPhone(event.target.value)}/></label>
    <label>Pickup address <input value={pickupAddress} disabled={busy} onChange={event=>setPickupAddress(event.target.value)}/></label>
    <label>Trip type <select value={tripType} disabled={busy} onChange={event=>setTripType(event.target.value as ClientTripType)}>
      <option value="ONE_WAY">One way</option>
      <option value="ROUND_TRIP">Round trip</option>
    </select></label>
    <label>Notes <textarea rows={3} value={notes} disabled={busy} onChange={event=>setNotes(event.target.value)}/></label>
    <label>Add drop-off addresses (one per line) <textarea rows={2} value={additional} disabled={busy} onChange={event=>setAdditional(event.target.value)}/></label>
    <button className="primary" disabled={busy} onClick={()=>void submit()}>Save client changes</button>
    <p role="status">{message}</p>
  </details>;
}
