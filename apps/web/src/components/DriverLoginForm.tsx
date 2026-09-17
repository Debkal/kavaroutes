import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {DevelopmentApiError} from "@kavaroutes/api-contracts/private-development-transport";
import type {createCloudApi} from "../cloud-api";

const LOGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
/** A login id the operator can read out loud: derived from the driver label, and
 * editable, so nothing has to match a phone format. */
const suggestLoginId = (label: string) => {
  const slug = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return (slug || "driver").slice(0, 40);
};

/** Dispatch issues a driver login. The one-time code is shown once, here, and only its
 * hash is stored, so it has to be handed to the driver over a separate channel. */
export function DriverLoginForm({api,serviceDate}:{api:ReturnType<typeof createCloudApi>;serviceDate:string}){
  const [driverId,setDriverId]=useState(""),[loginId,setLoginId]=useState("");
  const [message,setMessage]=useState(""),[invite,setInvite]=useState<{loginId:string;inviteCode:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const board=useQuery({queryKey:["private-cloud","driver-logins","fleet",serviceDate],queryFn:({signal})=>api.board(serviceDate,signal),retry:false});
  const drivers=board.data?.value.drivers??[];
  const choose=(value:string)=>{
    setDriverId(value);setMessage("");setInvite(null);
    const driver=drivers.find(item=>item.id===value);
    setLoginId(driver?suggestLoginId(driver.label):"");
  };
  const submit=async()=>{
    if(busy)return;
    if(!driverId){setMessage("Choose the driver this login belongs to.");return;}
    const id=loginId.trim();
    if(!LOGIN_ID.test(id)){setMessage("Use a simple login ID: letters, digits, dot, dash or underscore, at least 3 characters (for example 2223334444).");return;}
    setBusy(true);setMessage("Creating the driver login…");
    try{
      const receipt=await api.createDriverLogin({driverId,loginId:id},`web-driver-login-${crypto.randomUUID()}`);
      setInvite({loginId:receipt.value.loginId,inviteCode:receipt.value.inviteCode});
      setMessage(`Login invited for ${receipt.value.loginId}. Hand the one-time code to that driver; it will not be shown again.`);
    }catch(error){
      if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500&&error.code!=="OUTCOME_UNKNOWN"){
        const code=error.code;
        setMessage(code==="PERSISTENCE_DUPLICATE"?"That login ID already belongs to another driver."
          :code==="PERSISTENCE_RELATIONSHIP"?"That login ID is already taken, or the driver reference is unknown."
          :`The login was rejected: ${code.replaceAll("_"," ").toLowerCase()}.`);
      }else setMessage("Outcome unknown. Retry the original invite, or check the driver list before inviting again.");
    }finally{setBusy(false);}
  };
  return <section aria-label="Add a driver login">
    <h2>Add a driver login</h2>
    <p>Pick the driver and a login ID they can remember. The driver claims the login on their own device, sets their own password, and signs in with that ID from then on. Inviting the same driver again reissues the login: the old code and password stop working.</p>
    <label>Driver <select value={driverId} disabled={busy||board.isPending} onChange={event=>choose(event.target.value)}>
      <option value="">Choose driver</option>
      {drivers.map(driver=><option key={driver.id} value={driver.id}>{driver.label}</option>)}
    </select></label>
    {board.isError&&<p role="alert">The fleet list is unavailable, so a driver cannot be chosen right now.</p>}
    <label>Login ID <input value={loginId} placeholder="2223334444" disabled={busy} onChange={event=>{setMessage("");setInvite(null);setLoginId(event.target.value.trim());}}/></label>
    <button className="primary" disabled={busy} onClick={()=>void submit()}>Invite driver login</button>
    <p role="status">{message}</p>
    {invite&&<p role="status" className="driver-login-code">One-time code for {invite.loginId}: <strong>{invite.inviteCode}</strong></p>}
  </section>;
}
