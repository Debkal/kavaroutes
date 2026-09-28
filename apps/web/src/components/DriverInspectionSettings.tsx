import {useEffect,useState} from 'react';
import type {createCloudApi} from '../cloud-api';

export function DriverInspectionSettings({api,enabled}:{api:ReturnType<typeof createCloudApi>;enabled:boolean}){
  const [mode,setMode]=useState<'NO_ISSUE'|'MANUAL'|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  useEffect(()=>{if(enabled)void api.driverInspectionSettings().then(result=>setMode(result.value.precheckDefault)).catch(()=>setMessage('Vehicle check setting is unavailable.'));},[api,enabled]);
  const save=async(next:'NO_ISSUE'|'MANUAL')=>{
    setBusy(true);setMessage('Saving…');
    try{const result=await api.setDriverInspectionSettings(next);setMode(result.value.precheckDefault);setMessage('Saved for this business. Drivers will see this on their next sign-in.');}
    catch(error){setMessage(error instanceof Error?error.message:'Could not save the vehicle check setting.');}
    finally{setBusy(false);}
  };
  return <section id="vehicle-check-settings" className="workspace-card" aria-label="Vehicle check defaults">
    <div className="section-heading"><div><p className="eyebrow">Driver shift</p><h2>Vehicle precheck defaults</h2><p>Choose how answers appear before a driver submits the pre-trip check. Drivers must still submit the form and can report any issue.</p></div></div>
    <fieldset disabled={!enabled||busy||!mode} className="driver-segmented">
      <legend>Pre-trip item answers</legend>
      <label><input type="radio" name="precheck-default" checked={mode==='NO_ISSUE'} onChange={()=>void save('NO_ISSUE')}/> Preselect No issue</label>
      <label><input type="radio" name="precheck-default" checked={mode==='MANUAL'} onChange={()=>void save('MANUAL')}/> Leave empty; require each selection</label>
    </fieldset>
    {message&&<p role="status">{message}</p>}
  </section>;
}
