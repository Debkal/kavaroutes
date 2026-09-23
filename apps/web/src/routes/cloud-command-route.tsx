import {useMemo,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {createCloudApi} from "../cloud-api";
import {businessToday} from "../business-time";
import {CloudCommandRecovery} from "../components/CloudCommandRecovery";
import {DriverLoginForm} from "../components/DriverLoginForm";
import {ServiceDatePicker} from "../components/ServiceDatePicker";

export function Component(){
  const api=useMemo(()=>createCloudApi(window.location.origin,window.fetch.bind(window)),[]);
  const [serviceDate,setServiceDate]=useState(()=>businessToday());
  const session=useQuery({queryKey:["private-cloud","command-session"],queryFn:({signal})=>api.authenticate(signal),retry:false});
  return <main id="main-content" className="dispatch-page command-page">
    <section className="page-title"><div><p className="eyebrow">KavaRoutes Command</p><h1>Command control</h1><p>Manage driver access and review requests interrupted by a connection problem.</p></div>
      <span className={`dispatch-connection ${session.isSuccess?"ready":session.isError?"error":"connecting"}`}>{session.isSuccess?"Command connected":session.isError?"Command unavailable":"Connecting…"}</span></section>
    <nav className="dispatch-jump-nav" aria-label="Command control sections"><a href="#driver-access">Driver accounts</a><a href="#command-recovery">Interrupted requests</a></nav>
    <section className="workspace-card command-date" aria-label="Driver roster date"><ServiceDatePicker value={serviceDate} onChange={setServiceDate}/><p className="form-hint">Choose a date to see the drivers and assignments for that day.</p></section>
    {session.isSuccess&&<DriverLoginForm api={api} serviceDate={serviceDate}/>} 
    <section id="command-recovery" className="workspace-card" aria-label="Command recovery tools"><CloudCommandRecovery recovery={api.recovery} enabled={session.isSuccess}/></section>
    {session.isPending&&<p role="status">Connecting to Command…</p>}
    {session.isError&&<p role="alert">Command cannot reach the server. Account controls are unavailable.</p>}
  </main>;
}
