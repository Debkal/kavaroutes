import {useState} from 'react';

type Session={token:string;businessId:string;loginId:string};
type Invite={driverId:string;displayName:string;loginId:string;inviteCode:string};
const loginPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function Component(){
  const [session,setSession]=useState<Session|null>(null);
  const [loginId,setLoginId]=useState(''),[password,setPassword]=useState('');
  const [name,setName]=useState(''),[driverLogin,setDriverLogin]=useState('');
  const [relationship,setRelationship]=useState<'EMPLOYEE'|'CONTRACTOR'|'OWNER_OPERATOR'>('EMPLOYEE');
  const [invite,setInvite]=useState<Invite|null>(null);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  async function request(path:string,body?:unknown){
    const result=await fetch(path,{method:body?'POST':'GET',credentials:'omit',cache:'no-store',
      headers:{...(body?{'content-type':'application/json'}:{}),...(session?{authorization:`DriverAdmin ${session.token}`}:{})
      ,...(path==='/driver-admin/drivers'?{'idempotency-key':`driver-admin-${crypto.randomUUID()}`}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await result.json().catch(()=>({}));
    if(!result.ok)throw new Error(data.code==='LOGIN_REJECTED'?'Admin login and password did not match.':data.code==='SIGN_IN_REQUIRED'?'Admin session expired. Sign in again.':data.code==='RESOURCE_NOT_FOUND'?'Business driver account is unavailable.':`Request failed (${result.status}).`);
    return data;
  }
  async function signIn(event:React.FormEvent){
    event.preventDefault();if(busy)return;
    setBusy(true);setMessage('Checking business driver-admin login…');
    try{const account=await request('/driver-admin/session',{loginId:loginId.trim(),password});setSession(account);setPassword('');setMessage('Signed in. You can create driver accounts for this business.');}
    catch(error){setMessage(error instanceof Error?error.message:'Sign in failed.');}
    finally{setBusy(false);}
  }
  async function create(event:React.FormEvent){
    event.preventDefault();if(busy||!session)return;
    if(!name.trim()||!loginPattern.test(driverLogin.trim())){setMessage('Enter a driver name and valid login ID.');return;}
    setBusy(true);setMessage('Creating driver account…');setInvite(null);
    try{const created=await request('/driver-admin/drivers',{displayName:name.trim(),loginId:driverLogin.trim(),workforceRelationship:relationship});setInvite(created);setName('');setDriverLogin('');setMessage('Driver account created. Give the driver the setup link and one-time code below.');}
    catch(error){setMessage(error instanceof Error?error.message:'Could not create driver account.');}
    finally{setBusy(false);}
  }
  const setupUrl=invite&&session?`${window.location.origin}/driver?businessId=${encodeURIComponent(session.businessId)}&driverId=${encodeURIComponent(invite.driverId)}`:'';
  return <main id="main-content" className="message-page driver-admin-page">
    <p className="eyebrow">Business driver administration</p><h1>Driver accounts</h1>
    <p>Sign in with your business’s driver-admin login. Drivers use their own login on the <a href="/driver">Driver page</a>.</p>
    {!session?<form onSubmit={event=>void signIn(event)}>
      <label>Admin login ID<input autoComplete="username" value={loginId} onChange={event=>setLoginId(event.target.value)}/></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label>
      <button type="submit" disabled={busy}>Sign in</button>
    </form>:<><p>Business ID: <code>{session.businessId}</code></p>
      <form onSubmit={event=>void create(event)}>
        <label>Driver name<input value={name} onChange={event=>setName(event.target.value)}/></label>
        <label>Driver login ID<input value={driverLogin} onChange={event=>setDriverLogin(event.target.value)} placeholder="joeldriver"/></label>
        <label>Relationship<select value={relationship} onChange={event=>setRelationship(event.target.value as typeof relationship)}><option value="EMPLOYEE">Employee</option><option value="CONTRACTOR">Contractor</option><option value="OWNER_OPERATOR">Owner operator</option></select></label>
        <button type="submit" disabled={busy}>Create driver account</button>
      </form>
      {invite&&<div role="status"><p>One-time setup code for {invite.displayName} ({invite.loginId}):</p><strong>{invite.inviteCode}</strong><p><a href={setupUrl}>Open driver setup link</a></p><p>Share the link and code privately. The code is shown once.</p></div>}
      <button type="button" onClick={()=>{void request('/driver-admin/logout',{}).catch(()=>{});setSession(null);setInvite(null);setMessage('Signed out.');}}>Sign out</button>
    </>}
    <p role="status">{message}</p>
  </main>;
}
