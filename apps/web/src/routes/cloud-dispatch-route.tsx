import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createCloudApi } from "../cloud-api";
import { connectCloudDispatch } from "../cloud-live";
import {CloudBoard} from '../components/CloudBoard';
import {DispatchRouteForm} from '../components/DispatchRouteForm';
import {businessToday} from '../business-time';
import {scheduledClientReference,clearClientScheduling} from '../scheduling-handoff';

export function Component() {
  const [initialClientId]=useState(()=>scheduledClientReference());
  const [plannedRunId,setPlannedRunId]=useState<string|null>(null);
  useEffect(()=>{clearClientScheduling();},[]);
  const api = useMemo(() => createCloudApi(window.location.origin, window.fetch.bind(window)), []);
  const [serviceDate, setServiceDate] = useState(()=>businessToday());
  const [liveStatus, setLiveStatus] = useState("connecting");
  const session = useQuery({ queryKey: ["private-cloud", "session"], queryFn: ({ signal }) => api.authenticate(signal), retry: false });
  const dispatchSnapshot = useQuery({ queryKey: ["private-cloud", "dispatch-snapshot", serviceDate],
    queryFn: ({ signal }) => api.dispatchSnapshot(serviceDate, signal), enabled: session.isSuccess,
    retry: false, refetchInterval: 5000 });
  const refreshRef = useRef(async () => {});
  refreshRef.current = async () => {
    const result = await dispatchSnapshot.refetch();
    if (result.isError) throw new Error("CLOUD_REFRESH_FAILED");
  };
  useEffect(() => {
    if (!session.isSuccess) return;
    return connectCloudDispatch({ origin: window.location.origin, serviceDate,
      snapshot: async () => (await api.dispatchSnapshot(serviceDate)).value.cursor,
      refresh: () => refreshRef.current(), status: setLiveStatus });
  }, [api, serviceDate, session.isSuccess]);
  return <main id="main-content" className="dispatch-page">
    <section className="page-title"><div><p className="eyebrow">KavaRoutes Dispatch</p><h1>Your transportation day</h1>
      <p>Schedule client requests, assign drivers, and follow each trip from pickup to drop-off.</p></div>
      <span className={`dispatch-connection ${session.isSuccess?"ready":session.isError?"error":"connecting"}`}>{session.isSuccess?"Dispatch connected":session.isError?"Dispatch unavailable":"Connecting…"}</span></section>
    <nav className="dispatch-jump-nav" aria-label="Dispatch workspace sections">
      <a href="#schedule-transport">Schedule transport</a>
      <a href="#dispatch-operations">Assign drivers</a>
    </nav>
    <section id="schedule-transport" className="workspace-card schedule-panel" aria-label="Schedule transport"><DispatchRouteForm api={api} serviceDate={serviceDate} onServiceDateChange={setServiceDate} initialClientId={initialClientId} onPlanned={setPlannedRunId}/></section>
    <CloudBoard api={api} enabled={session.isSuccess} serviceDate={serviceDate} onServiceDateChange={setServiceDate} focusRunId={plannedRunId} onFocusRunHandled={()=>setPlannedRunId(null)}/>
    {session.isPending && <p role="status">Connecting to cloud session…</p>}
    {session.isError && <p role="alert">Dispatch is disconnected. Trip and driver details may be out of date. Check your connection and refresh before making changes.</p>}
  </main>;
}
