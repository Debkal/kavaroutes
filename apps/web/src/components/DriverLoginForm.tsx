import {useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Link} from "react-router";
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
  const [newName,setNewName]=useState(""),[newLoginId,setNewLoginId]=useState(""),[relationship,setRelationship]=useState<'OWNER_OPERATOR'|'EMPLOYEE'|'CONTRACTOR'>('EMPLOYEE');
  const [newLoginEdited,setNewLoginEdited]=useState(false);
  const [message,setMessage]=useState(""),[invite,setInvite]=useState<{driverId:string;loginId:string;inviteCode:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const pending=useRef<{request:{driverId:string;loginId:string};key:string}|null>(null);
  const addPending=useRef<{request:{displayName:string;loginId:string;workforceRelationship:'OWNER_OPERATOR'|'EMPLOYEE'|'CONTRACTOR'};key:string}|null>(null);
  const board=useQuery({queryKey:["private-cloud","driver-logins","fleet",serviceDate],queryFn:({signal})=>api.board(serviceDate,signal),retry:false});
  const drivers=board.data?.value.drivers??[];
  const choose=(value:string)=>{
    if(pending.current)return;
    setDriverId(value);setMessage("");setInvite(null);
    const driver=drivers.find(item=>item.id===value);
    setLoginId(driver?suggestLoginId(driver.label):"");
  };
  const submit=async(reset=false)=>{
    if(busy)return;
    if(!driverId){setMessage("Choose the driver this login belongs to.");return;}
    const id=loginId.trim();
    if(!LOGIN_ID.test(id)){setMessage("Use a simple login ID: letters, digits, dot, dash or underscore, at least 3 characters (for example 2223334444).");return;}
    if(reset&&!window.confirm(`Reset the password for ${selected?.label??"this driver"}? Their current password will stop working immediately.`))return;
    pending.current??={request:{driverId,loginId:id},key:`web-driver-login-${crypto.randomUUID()}`};
    setBusy(true);setMessage(reset?"Resetting the driver password…":"Issuing the driver login…");
    try{
      const receipt=await api.createDriverLogin(pending.current.request,pending.current.key);
      pending.current=null;
      setInvite({driverId:receipt.value.driverId,loginId:receipt.value.loginId,inviteCode:receipt.value.inviteCode});
      setMessage(`${reset?"Password reset":"Login issued"} for ${receipt.value.loginId}. Give the one-time code to that driver; it will not be shown again.`);
    }catch(error){
      if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500&&error.code!=="OUTCOME_UNKNOWN"){
        const code=error.code;pending.current=null;
        setMessage(code==="REQUEST_CONFLICT"?"That login ID is already taken or this driver already has an active invitation."
          :`The login was rejected: ${code.replaceAll("_"," ").toLowerCase()}.`);
      }else setMessage("Outcome unknown. Retry the original invite, or check the driver list before inviting again.");
    }finally{setBusy(false);}
  };
  const addDriver=async()=>{
    if(busy)return;
    const displayName=newName.trim(),id=newLoginId.trim();
    if(!displayName){setMessage("Enter the driver’s display name.");return;}
    if(displayName.length>120){setMessage("Driver display name must be 120 characters or fewer.");return;}
    if(!LOGIN_ID.test(id)){setMessage("Choose a login ID with at least 3 letters, digits, dots, dashes, or underscores.");return;}
    addPending.current??={request:{displayName,loginId:id,workforceRelationship:relationship},key:`web-driver-account-${crypto.randomUUID()}`};
    setBusy(true);setMessage("Adding the driver account…");setInvite(null);
    try{
      const receipt=await api.createDriverAccount(addPending.current.request,addPending.current.key);
      addPending.current=null;setNewName("");setNewLoginId("");setNewLoginEdited(false);setRelationship('EMPLOYEE');
      setInvite({driverId:receipt.value.driverId,loginId:receipt.value.loginId,inviteCode:receipt.value.inviteCode});
      setMessage(`${receipt.value.displayName} was added. Give the one-time code to the driver so they can set their password.`);
      await board.refetch();
    }catch(error){
      if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500&&error.code!=="OUTCOME_UNKNOWN"){
        addPending.current=null;
        setMessage(error.code==='PERSISTENCE_DUPLICATE'?'That driver name or login ID is already in use.':`The driver account was rejected: ${error.code.replaceAll('_',' ').toLowerCase()}.`);
      }else setMessage("Outcome unknown. Retry the original add-driver request; do not create a replacement.");
    }finally{setBusy(false);}
  };
  const selected=drivers.find(item=>item.id===driverId);
  return <section id="driver-access" className="workspace-card driver-access-panel" aria-label="Driver access">
    <div className="section-heading"><div><p className="eyebrow">Account administration</p><h2>Driver accounts</h2><p>Select a driver to issue access or reset a forgotten password.</p></div><Link className="action-link" to="/driver">Open Driver portal →</Link></div>
    <details className="add-driver-account"><summary>Add driver account</summary>
      <div className="driver-account-create">
        <label>Driver display name <input value={newName} maxLength={120} disabled={busy||!!addPending.current} autoComplete="name" onChange={event=>{const value=event.target.value;setMessage("");setNewName(value);if(!newLoginEdited)setNewLoginId(suggestLoginId(value));}}/></label>
        <label>Login ID <input value={newLoginId} maxLength={64} disabled={busy||!!addPending.current} autoCapitalize="none" autoCorrect="off" onChange={event=>{setMessage("");setNewLoginEdited(true);setNewLoginId(event.target.value.trim());}}/></label>
        <label>Workforce relationship <select value={relationship} disabled={busy||!!addPending.current} onChange={event=>setRelationship(event.target.value as typeof relationship)}><option value="EMPLOYEE">Employee</option><option value="CONTRACTOR">Contractor</option><option value="OWNER_OPERATOR">Owner-operator</option></select></label>
        <button className="primary" disabled={busy||!newName.trim()||!newLoginId.trim()} onClick={()=>void addDriver()}>{addPending.current?'Retry original request':'Add driver and issue login code'}</button>
      </div>
      <p className="form-hint">The workforce relationship controls which organization policies apply. It does not change the Small Business or Enterprise subscription tier.</p>
    </details>
    <div className="driver-access-layout"><div className="driver-roster" aria-label="Driver roster">
      {drivers.map(driver=>{const assigned=board.data?.value.runs.filter(run=>run.driverId===driver.id).length??0;return <button key={driver.id} className={driver.id===driverId?'selected':''} aria-pressed={driver.id===driverId} onClick={()=>choose(driver.id)}><strong>{driver.label}</strong><span>{assigned?`${assigned} assigned run${assigned===1?'':'s'}`:'No runs assigned'}</span></button>})}
      {!board.isPending&&!board.isError&&!drivers.length&&<p>No drivers are available for this service day.</p>}
    </div><div className="driver-login-form">
    <h3>{selected?`Account for ${selected.label}`:'Choose a driver'}</h3>
    <p>The driver enters the one-time code once, chooses a password, and then signs in with the login ID.</p>
    <label>Driver <select value={driverId} disabled={busy||board.isPending||!!pending.current} onChange={event=>choose(event.target.value)}>
      <option value="">Choose driver</option>
      {drivers.map(driver=><option key={driver.id} value={driver.id}>{driver.label}</option>)}
    </select></label>
    {board.isError&&<p role="alert">The fleet list is unavailable, so a driver cannot be chosen right now.</p>}
    <label>Login ID <input value={loginId} placeholder="driver-name" disabled={busy||!!pending.current} onChange={event=>{setMessage("");setInvite(null);setLoginId(event.target.value.trim());}}/></label>
    <div className="driver-account-actions"><button className="primary" disabled={busy||!driverId} onClick={()=>void submit(false)}>{pending.current?'Retry original request':'Issue login code'}</button>
    <button disabled={busy||!driverId||!!pending.current} onClick={()=>void submit(true)}>Reset password</button></div>
    <p className="form-hint">Resetting invalidates the current password and creates a new one-time code. The driver must set a new password before signing in again.</p>
    <p role="status">{message}</p>
    {invite&&<div role="status" className="driver-login-code"><span>One-time code for {invite.loginId}</span><strong>{invite.inviteCode}</strong><a className="action-link" href={`/driver?driverId=${encodeURIComponent(invite.driverId)}`}>Open driver setup link</a><small>Give this link and code to the driver. The code will not be shown again.</small></div>}
    </div></div>
  </section>;
}
