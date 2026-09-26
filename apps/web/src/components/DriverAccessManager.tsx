import {useEffect,useState} from 'react';
import type {createCloudApi,DriverAccessView} from '../cloud-api';

const when=(value:number)=>value?new Date(value).toLocaleString():'Not recorded';
export function DriverAccessManager({api,enabled}:{api:ReturnType<typeof createCloudApi>;enabled:boolean}){
  const [view,setView]=useState<DriverAccessView|null>(null);
  const [label,setLabel]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [issued,setIssued]=useState<{code:string;password:string}|null>(null);
  const refresh=async()=>{const result=await api.driverAccess();setView(result.value);};
  useEffect(()=>{if(enabled)void refresh().catch(()=>setMessage('Driver access controls are unavailable. Try refreshing.'));},[enabled]);
  const run=async(action:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setMessage('Saving access changes…');setIssued(null);
    try{await action();await refresh();setMessage('Access changes saved.');}
    catch(error){setMessage(error instanceof Error?error.message:'Access change failed. Check the current list before retrying.');}
    finally{setBusy(false);}
  };
  const create=(kind:'SHARED'|'ONE_DEVICE')=>void run(async()=>{
    const result=await api.createDriverAccessCode(kind,label.trim());setIssued({code:result.value.code,password:result.value.password});setLabel('');
  });
  return <section id="business-access" className="workspace-card driver-access-manager" aria-label="Business access management">
    <div className="section-heading"><div><p className="eyebrow">Driver devices</p><h2>Business access</h2><p>Manage the business password drivers enter before their own login. Existing trip GPS uploads keep their driver session if a device is signed out here.</p></div><button type="button" disabled={!enabled||busy} onClick={()=>void refresh().catch(()=>setMessage('Could not refresh access controls.'))}>Refresh</button></div>
    {!enabled?<p>Connect Command to manage this business’s access.</p>:<>
      <label>Device label (optional)<input value={label} maxLength={80} onChange={event=>setLabel(event.target.value)} placeholder="Joel’s phone"/></label>
      <div className="form-actions"><button type="button" disabled={busy} onClick={()=>create('ONE_DEVICE')}>Issue one-device code</button><button type="button" disabled={busy} onClick={()=>create('SHARED')}>Issue shared code</button></div>
      {issued&&<div role="status" className="driver-login-code"><span>Give these credentials to the driver securely. The password appears only now.</span><strong>Code: {issued.code}</strong><strong>Password: {issued.password}</strong><button type="button" onClick={()=>setIssued(null)}>Hide credentials</button></div>}
      <h3>Access codes</h3>
      {!view?.codes.length?<p>No codes for this business.</p>:<div className="table-scroll"><table><thead><tr><th>Code</th><th>Type</th><th>Device / uses</th><th>Actions</th></tr></thead><tbody>{view.codes.map(code=><tr key={code.id}><td><strong>{code.code}</strong><small>{code.label||''}</small></td><td>{code.kind==='ONE_DEVICE'?'One device':'Shared'}{!code.enabled?' · Disabled':''}</td><td>{code.uses}</td><td><button type="button" disabled={busy||!code.enabled} onClick={()=>{if(window.confirm(`Reset ${code.code}? Its enrolled devices will be signed out of business access.`))void run(async()=>{const result=await api.resetDriverAccessCode(code.id);setIssued({code:result.value.code,password:result.value.password});});}}>Reset password</button> <button type="button" disabled={busy||!code.enabled} onClick={()=>{if(window.confirm(`Disable ${code.code} and sign out its devices?`))void run(async()=>{await api.disableDriverAccessCode(code.id);});}}>Disable</button></td></tr>)}</tbody></table></div>}
      <h3>Enrolled devices</h3>
      {!view?.devices.length?<p>No devices enrolled yet.</p>:<div className="table-scroll"><table><thead><tr><th>Device</th><th>Code</th><th>Last active</th><th>Status</th><th>Action</th></tr></thead><tbody>{view.devices.map(device=><tr key={device.id}><td>{device.label}</td><td>{view.codes.find(code=>code.id===device.codeId)?.code??'Disabled code'}</td><td>{when(device.lastSeenAt)}</td><td>{device.revokedAt?'Signed out':device.expiresAt<Date.now()?'Expired':'Active until '+when(device.expiresAt)}</td><td><button type="button" disabled={busy||!!device.revokedAt||device.expiresAt<Date.now()} onClick={()=>{if(window.confirm(`Sign out ${device.label} from business access?`))void run(async()=>{await api.signOutDriverDevice(device.id);});}}>Sign out</button></td></tr>)}</tbody></table></div>}
      <details><summary>Recent access activity</summary><ul>{view?.events.map((event,index)=><li key={`${event.at}-${index}`}>{when(event.at)} · {event.action.replaceAll('_',' ').toLowerCase()} · {event.actor}</li>)}</ul></details>
      <p role="status">{message}</p>
    </>}
  </section>;
}
