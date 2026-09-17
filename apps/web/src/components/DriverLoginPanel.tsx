import {useState} from "react";
import {DevelopmentApiError} from "@kavaroutes/api-contracts/private-development-transport";
import type {createCloudDriverWebApi} from "../cloud-driver-api";

const LOGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
/** Driver-side login: claim the invite once and set a password, then sign in with that
 * ID and password. The server answers one rejection code for every failure, so this
 * screen never says whether the ID or the password was wrong. */
export function DriverLoginPanel({api,driverReference,onVerified}:{api:ReturnType<typeof createCloudDriverWebApi>;
  driverReference:string|null;onVerified:(driverId:string,loginId:string)=>void}){
  const [code,setCode]=useState(""),[password,setPassword]=useState("");
  const [loginId,setLoginId]=useState(""),[signInPassword,setSignInPassword]=useState("");
  const [message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const fail=(error:unknown,fallback:string)=>{
    if(error instanceof DevelopmentApiError&&error.code==="DRIVER_LOGIN_REJECTED")return "That login ID and password did not match a driver login.";
    if(error instanceof DevelopmentApiError&&error.code==="DRIVER_LOGIN_DRIVER_MISMATCH")return "This invite belongs to another driver. Ask dispatch to reissue it for your driver.";
    if(error instanceof DevelopmentApiError&&error.code==="OUTCOME_UNKNOWN")return "Outcome unknown. Retry the same request; it does not create a second credential.";
    if(error instanceof DevelopmentApiError&&error.status>=400&&error.status<500)return `Rejected: ${error.code.replaceAll("_"," ").toLowerCase()}.`;
    return fallback;
  };
  const claim=async()=>{
    if(busy)return;
    if(!driverReference){setMessage("Sign in is unavailable until the server reports your driver reference.");return;}
    if(code.trim().length<8){setMessage("Enter the one-time code dispatch gave you.");return;}
    if(password.length<8){setMessage("Choose a password of at least 8 characters.");return;}
    setBusy(true);setMessage("Setting your password…");
    try{
      const claimed=await api.claimLogin({driverId:driverReference,inviteCode:code.trim(),password},`web-claim-${crypto.randomUUID()}`);
      setCode("");setPassword("");onVerified(claimed.value.driverId,claimed.value.loginId);
      setMessage("Your password is set. Opening today’s itinerary…");
    }catch(error){setMessage(fail(error,"Your password could not be set."));}
    finally{setBusy(false);}
  };
  const signIn=async()=>{
    if(busy)return;
    const id=loginId.trim();
    if(!LOGIN_ID.test(id)){setMessage("Enter your login ID, for example 2223334444.");return;}
    if(signInPassword.length<8){setMessage("Enter your password.");return;}
    setBusy(true);setMessage("Checking your driver login…");
    try{
      const state=await api.verifyLogin({loginId:id,password:signInPassword},`web-verify-${crypto.randomUUID()}`);
      setSignInPassword("");onVerified(state.value.driverId,state.value.loginId);
      setMessage("Login accepted. Opening today’s itinerary…");
    }catch(error){setMessage(fail(error,"That driver login was not accepted."));}
    finally{setBusy(false);}
  };
  return <section className="driver-login-panel" aria-label="Driver login">
    <h2>Driver login</h2>
    <p>First time here: enter the one-time code dispatch gave you and choose your own password. After that, sign in with your login ID and password.</p>
    <details>
      <summary>First login: set your password</summary>
      <label>One-time code <input value={code} disabled={busy} onChange={event=>setCode(event.target.value.trim())}/></label>
      <label>New password <input type="password" value={password} disabled={busy} onChange={event=>setPassword(event.target.value)}/></label>
      <button className="driver-primary" disabled={busy} onClick={()=>void claim()}>Set password and open itinerary</button>
    </details>
    <fieldset disabled={busy}>
      <legend>Sign in with your password</legend>
      <label>Login ID <input value={loginId} placeholder="2223334444" onChange={event=>setLoginId(event.target.value.trim())}/></label>
      <label>Password <input type="password" value={signInPassword} onChange={event=>setSignInPassword(event.target.value)}/></label>
      <button className="driver-primary" onClick={()=>void signIn()}>Sign in and open itinerary</button>
    </fieldset>
    <p role="status">{message}</p>
  </section>;
}
