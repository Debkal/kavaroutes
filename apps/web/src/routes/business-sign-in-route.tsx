import {useEffect,useState} from 'react';
import {prepareBusinessSignIn,signInBusiness,resetBusinessPassword} from '../business-auth';

const messages:Record<string,string>={
 BUSINESS_EMAIL_VERIFICATION_REQUIRED:'Verify your email address before signing in.',
 BUSINESS_MEMBERSHIP_REQUIRED:'Your account has no active business workspace. Contact your business administrator.',
 BUSINESS_SIGN_IN_UNAVAILABLE:'Business sign-in is being configured. Please contact support.',
};
export function Component(){
 const [enabled,setEnabled]=useState<boolean|null>(null),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [selection,setSelection]=useState<Awaited<ReturnType<typeof signInBusiness>>|null>(null);
 useEffect(()=>{void prepareBusinessSignIn().then(config=>setEnabled(config.authEnabled)).catch(()=>setEnabled(false));},[]);
 const signIn=async(provider?:'google'|'microsoft')=>{
  setBusy(true);setMessage('');
  try{
   const result=await signInBusiness(provider?{provider}:{email,password});setPassword('');
   if(result.businesses.length===1){await result.select(result.businesses[0]!.organizationId);window.location.assign('/dispatch');}
   else setSelection(result);
  }catch(error){const code=error instanceof Error?error.message:'';setMessage(messages[code]??'We could not sign you in. Check your credentials and try again.');}
  finally{setBusy(false);}
 };
 return <main id="main-content" className="message-page business-sign-in"><p className="eyebrow">KavaRoutes Business</p><h1>Sign in to your business</h1>
  {enabled===null?<p role="status">Loading sign-in…</p>:enabled===false?<p role="status">Business sign-in is being configured. Please contact support.</p>:selection?
   <div><p>Select your business workspace.</p>{selection.businesses.map(business=><button key={business.organizationId} disabled={busy} onClick={()=>{setBusy(true);void selection.select(business.organizationId).then(()=>window.location.assign('/dispatch')).catch(()=>{setBusy(false);setMessage('Unable to open this business. Sign in again.');setSelection(null);});}}>{business.name}</button>)}</div>:
   <form onSubmit={event=>{event.preventDefault();void signIn();}}><label>Email<input type="email" autoComplete="username" required value={email} onChange={event=>setEmail(event.target.value)}/></label>
    <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></label>
    <button type="submit" disabled={busy}>Sign in</button>
    <div><button type="button" disabled={busy} onClick={()=>void signIn('google')}>Continue with Google</button><button type="button" disabled={busy} onClick={()=>void signIn('microsoft')}>Continue with Microsoft</button></div>
    <button type="button" disabled={busy||!email} onClick={()=>{setBusy(true);void resetBusinessPassword(email).then(()=>setMessage('If your account exists, check your email for a password reset link.')).catch(()=>setMessage('Could not request a password reset. Please try again.')).finally(()=>setBusy(false));}}>Reset password</button>
   </form>}
  {message&&<p role="alert">{message}</p>}
 </main>;
}
