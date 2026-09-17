import {useRef,useState} from "react";
import {DevelopmentApiError} from "@kavaroutes/api-contracts/private-development-transport";
import type {ClientCreateReceipt,ClientCreateRequest,createCloudClientApi} from "../cloud-client-api";

const limits = {displayName: 200, entityName: 200, phone: 40, address: 512, notes: 2000} as const;
const optional = (value: string, max: number, label: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new Error(`Keep the ${label} to ${max} characters or fewer.`);
  return trimmed;
};

export function ClientIntakeForm({api,onCreated}:{api:ReturnType<typeof createCloudClientApi>;onCreated?:(receipt:ClientCreateReceipt)=>void}){
  const [displayName,setDisplayName]=useState(""),[entityName,setEntityName]=useState(""),[phone,setPhone]=useState("");
  const [pickupAddress,setPickupAddress]=useState("");
  const [notes,setNotes]=useState("");
  const [message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const pending=useRef<{request:ClientCreateRequest;key:string}|null>(null);
  const build=():ClientCreateRequest=>{
    const name=displayName.trim();
    if (!name) throw new Error("Enter the client name.");
    if (name.length>limits.displayName) throw new Error(`Keep the client name to ${limits.displayName} characters or fewer.`);
    const pickup=pickupAddress.trim();
    if (!pickup) throw new Error("Enter the client's home or usual pickup address.");
    if (pickup.length>limits.address) throw new Error(`Keep the pickup address to ${limits.address} characters or fewer.`);
    if(phone.trim()&&phone.trim().length<3)throw new Error("Enter a phone number of at least 3 characters, or leave it blank.");
    return {displayName:name,entityName:optional(entityName,limits.entityName,"entity"),phone:optional(phone,limits.phone,"phone"),
      pickupAddress:pickup,notes:optional(notes,limits.notes,"notes")};
  };
  const submit=async()=>{
    if (busy) return;
    if (!pending.current){
      try { pending.current={request:build(),key:`web-client-${crypto.randomUUID()}`}; }
      catch (error){ setMessage(error instanceof Error?error.message:"Review the client fields."); return; }
    }
    setBusy(true);setMessage("Saving the client to the server…");
    try{
      const receipt=await api.create(pending.current.request,pending.current.key);
      pending.current=null;
      setDisplayName("");setEntityName("");setPhone("");setPickupAddress("");setNotes("");
      setMessage(`${receipt.value.displayName} saved. Schedule their transport in Dispatch.`);
      onCreated?.(receipt.value);
    }catch(error){
      if (error instanceof DevelopmentApiError && error.status>=400 && error.status<500 && error.code!=="OUTCOME_UNKNOWN"){
        const code=error.code;pending.current=null;
        setMessage(code==="REQUEST_CONFLICT"?"The client could not be saved. Check their name and home address, then resubmit.":error.status===400||error.status===422?"The server could not accept these client details. Check the name, home address, and phone number, then try again.":`Client rejected: ${code.replaceAll("_"," ").toLowerCase()}.`);
      }else setMessage("Outcome unknown. The server may already have saved this client. Retry the original save here, or refresh the roster and look for it before adding another client.");
    }finally{setBusy(false);}
  };
  return <section aria-label="Add a client">
    <h2>Add a client</h2>
    <p>Save their contact details and home address. Dispatch manages destinations separately for each trip.</p>
    <label>Client name <input value={displayName} disabled={busy||!!pending.current} onChange={event=>{setMessage("");setDisplayName(event.target.value);}}/></label>
    <label>Entity (optional) <input value={entityName} disabled={busy||!!pending.current} onChange={event=>setEntityName(event.target.value)}/></label>
    <label>Phone (optional) <input type="tel" maxLength={40} value={phone} disabled={busy||!!pending.current} onChange={event=>setPhone(event.target.value)}/></label>
    <label>Home / usual pickup address <input maxLength={512} value={pickupAddress} disabled={busy||!!pending.current} onChange={event=>setPickupAddress(event.target.value)}/></label>
    <label>Notes <textarea value={notes} rows={3} disabled={busy||!!pending.current} onChange={event=>setNotes(event.target.value)}/></label>
    <button className="primary" disabled={busy||!displayName.trim()} onClick={()=>void submit()}>{pending.current?"Retry the original client save":"Add client"}</button>
    <p role="status">{message}</p>
    {pending.current&&<p>This tab still holds the original request. Retrying it replays the same command; it does not create a second client.</p>}
  </section>;
}
