import {useEffect,useMemo,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Link,useNavigate,type LoaderFunctionArgs} from "react-router";
import {prepareClientScheduling} from "../scheduling-handoff";
import {createCloudClientApi} from "../cloud-client-api";
import {ClientIntakeForm} from "../components/ClientIntakeForm";
import {ClientEditForm} from "../components/ClientEditForm";
import {queryClient} from "../runtime";
import {businessTimezone} from "../business-time";
import {clientDirectoryRows,downloadCsv} from "../csv";

const context=["private-cloud","clients"] as const;

export function loader({request}:LoaderFunctionArgs){
  if(new URL(request.url).search)throw new Response("Invalid client context",{status:400});
  return null;
}

export function Component(){
  const navigate=useNavigate();
  const schedule=(clientId:string)=>{prepareClientScheduling(clientId);navigate("/dispatch");};
  const api=useMemo(()=>createCloudClientApi(window.location.origin,window.fetch.bind(window)),[]);
  const [selected,setSelected]=useState<string|null>(null);
  const [message,setMessage]=useState("");
  const [search,setSearch]=useState("");
  const session=useQuery({queryKey:[...context,"session"],queryFn:({signal})=>api.authenticate(signal),retry:false,refetchInterval:30000});
  const roster=useQuery({queryKey:[...context,"roster"],queryFn:({signal})=>api.roster(undefined,signal),enabled:session.isSuccess,retry:false,refetchInterval:10000});
  useEffect(()=>()=>{void queryClient.cancelQueries({queryKey:context});queryClient.removeQueries({queryKey:context});},[]);
  const clients=session.isSuccess&&!roster.isError?roster.data?.value.clients??[]:[];
  const visible=clients.filter(client=>`${client.displayName} ${client.entityName??""} ${client.phone??""}`.toLowerCase().includes(search.toLowerCase().trim()));
  const active=clients.find(client=>client.clientId===selected)??clients[0];
  // The directory exported as one counted sheet: destinations per client, how often each
  // was scheduled, and the most used / most recent one.
  const exportDirectory=()=>downloadCsv(`kavaroutes-clients-${new Date().toISOString().slice(0,10)}.csv`,clientDirectoryRows(clients));
  const frequentDropoffs=active?[...active.dropoffAddresses].sort((a,b)=>b.usageCount-a.usageCount||Date.parse(b.lastUsedAt??"1970-01-01")-Date.parse(a.lastUsedAt??"1970-01-01")||a.addressLabel.localeCompare(b.addressLabel)):[];
  return <main id="main-content" className="clients-page">
    <section className="page-title"><div><p className="eyebrow">KavaRoutes · Client directory</p><h1>People you transport</h1>
      <p>Contact details and home addresses in one place. Schedule destinations and trip requests in Dispatch.</p></div>
      <div className="section-heading-actions"><button disabled={!clients.length} onClick={exportDirectory}>Export directory CSV</button><Link className="action-link" to="/dispatch">Open Dispatch →</Link></div></section>
    <div className="clients-workspace">
    <details className="intake-panel"><summary>Add a client</summary>
    <ClientIntakeForm api={api} onCreated={receipt=>{setSelected(receipt.clientId);setMessage(`Client ${receipt.displayName} is selected.`);void roster.refetch();}}/>
    </details>
    <section className="workspace-card" aria-label="Client roster">
      <h2>Client directory <span className="driver-pill">{clients.length}</span></h2>
      <label>Find a client <input type="search" value={search} placeholder="Name, organization, or phone" onChange={event=>setSearch(event.target.value)}/></label>
      <button disabled={!session.isSuccess} onClick={()=>void roster.refetch()}>Refresh clients</button>
      {session.isError?<p role="alert">We could not confirm your access to client records. Refresh the page or sign in again.</p>
       :session.isPending?<p role="status">Checking dispatch access…</p>
       :roster.isError?<p role="alert">Client records could not be loaded. Select Refresh clients to try again.</p>
       :roster.isPending?<p role="status">Loading clients…</p>
       :<><div className="table-scroll" tabIndex={0} role="group" aria-label="Client directory table, scrollable"><table><caption>Client contact and pickup details</caption>
        <thead><tr><th>Client</th><th>Organization</th><th>Phone</th><th>Home / usual pickup</th><th>Details</th></tr></thead>
        <tbody>{visible.map((client)=><tr key={client.clientId}>
          <th scope="row">{client.displayName}</th><td>{client.entityName??"—"}</td><td>{client.phone??"—"}</td>
          <td>{client.pickupAddress??"Not recorded"}</td>
          <td><button aria-label={`View ${client.displayName}`} aria-pressed={active?.clientId===client.clientId} onClick={()=>setSelected(client.clientId)}>View</button><button className="primary" aria-label={`Schedule transport for ${client.displayName}`} onClick={()=>schedule(client.clientId)}>Schedule transport</button></td>
        </tr>)}</tbody></table></div>
        {clients.length>0&&visible.length===0&&<p>No matching clients. Try another name or phone number.</p>}
        {clients.length===0&&<p>No clients are recorded yet. Add the first one above.</p>}</>}
      <p role="status">{message}</p>
    </section>
    {active&&<section className="workspace-card client-profile" aria-label="Selected client">
      <p className="eyebrow">Client profile</p><h2>{active.displayName}</h2>
      <dl><dt>Entity</dt><dd>{active.entityName??"Not recorded"}</dd><dt>Phone</dt><dd>{active.phone??"Not recorded"}</dd>
        <dt>Home / usual pickup address</dt><dd>{active.pickupAddress??"Not recorded"}</dd>
        <dt>Notes</dt><dd>{active.notes??"None"}</dd></dl>
      <h3>Transport requests</h3><p>Dispatch chooses the destination and pickup time for each trip. The home address stays with this client.</p>
      <button className="primary" onClick={()=>schedule(active.clientId)}>Schedule transport →</button>
      <h3>Drop-off address directory</h3>
      {frequentDropoffs.length===0?<p>No drop-off addresses recorded yet. The first destination scheduled in Dispatch will be added here.</p>
       :<div className="table-scroll" tabIndex={0} role="group" aria-label="Drop-off addresses sorted by frequency"><table><caption>Most frequently used destinations first</caption>
        <thead><tr><th scope="col">Drop-off address</th><th scope="col">Trips</th><th scope="col">Last used</th></tr></thead>
        <tbody>{frequentDropoffs.map(dropoff=><tr key={dropoff.ordinal}><th scope="row">{dropoff.addressLabel}</th><td>{dropoff.usageCount}</td>
          <td>{dropoff.lastUsedAt?new Date(dropoff.lastUsedAt).toLocaleDateString("en-US",{timeZone:businessTimezone}):"Not scheduled yet"}</td></tr>)}</tbody></table></div>}
      <ClientEditForm api={api} client={active} onSaved={()=>{setMessage(`Changes saved for ${active.displayName}.`);void roster.refetch();}}/>
      <h3>Scheduled trips</h3>
      {active.routes.length===0?<p>No routes planned for this client yet. Plan one in Dispatch and pick this client.</p>
       :<ul>{active.routes.map((route,index)=><li key={route.tripId}>Trip {index+1} · {route.serviceDate}</li>)}</ul>}
    </section>}
    </div>
  </main>;
}
