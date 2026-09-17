import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createCloudApi } from "../cloud-api";
import type { TripCreateRequest } from "@kavaroutes/api-contracts/client-web";
import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";
import { connectCloudDispatch } from "../cloud-live";
import {CloudBoard} from '../components/CloudBoard';
import {CloudCommandRecovery} from '../components/CloudCommandRecovery';

function syntheticNineAm(serviceDate: string) {
  const localClock = Date.parse(`${serviceDate}T09:00:00.000Z`);
  if (!Number.isFinite(localClock)) throw new Error("INVALID_SERVICE_DATE");
  let resolved = localClock;
  let offsetSeconds = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" })
      .formatToParts(new Date(resolved)).find(part => part.type === "timeZoneName")?.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
    if (!match) throw new Error("SERVICE_TIMEZONE_UNAVAILABLE");
    offsetSeconds = (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 3600 + Number(match[3]) * 60);
    resolved = localClock - offsetSeconds * 1000;
  }
  return { resolvedServiceAt: new Date(resolved).toISOString(), resolvedUtcOffsetSeconds: offsetSeconds };
}

export function Component() {
  const api = useMemo(() => createCloudApi(window.location.origin, window.fetch.bind(window)), []);
  const [cursor, setCursor] = useState<string | null>(null);
  const [serviceDate, setServiceDate] = useState("2026-09-14");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveStatus, setLiveStatus] = useState("connecting");
  const pending = useRef<{ request: TripCreateRequest; key: string } | null>(null);
  const cancelPending = useRef<{ tripId: string; etag: string; key: string } | null>(null);
  const session = useQuery({ queryKey: ["private-cloud", "session"], queryFn: ({ signal }) => api.authenticate(signal), retry: false });
  const trips = useQuery({ queryKey: ["private-cloud", "trips", cursor], queryFn: ({ signal }) => api.list(cursor, signal), enabled: session.isSuccess, retry: false, refetchInterval: 5000 });
  const dispatchSnapshot = useQuery({ queryKey: ["private-cloud", "dispatch-snapshot", serviceDate],
    queryFn: ({ signal }) => api.dispatchSnapshot(serviceDate, signal), enabled: session.isSuccess,
    retry: false, refetchInterval: 5000 });
  const refreshRef = useRef(async () => {});
  refreshRef.current = async () => {
    const results = await Promise.all([trips.refetch(), dispatchSnapshot.refetch()]);
    if (results.some(result => result.isError)) throw new Error("CLOUD_REFRESH_FAILED");
  };
  useEffect(() => {
    if (!session.isSuccess) return;
    return connectCloudDispatch({ origin: window.location.origin, serviceDate,
      snapshot: async () => (await api.dispatchSnapshot(serviceDate)).value.cursor,
      refresh: () => refreshRef.current(), status: setLiveStatus });
  }, [api, serviceDate, session.isSuccess]);
  const report = (error: unknown) => setMessage(error instanceof DevelopmentApiError && error.code === "OUTCOME_UNKNOWN"
    ? "Outcome unknown. Retry the same command to recover its receipt; do not create a replacement."
    : error instanceof DevelopmentApiError ? error.code.replaceAll("_", " ") : "Request unavailable.");
  const create = async () => {
    if (busy || cancelPending.current) return;
    const resolved = syntheticNineAm(serviceDate);
    setBusy(true);
    pending.current ??= { key: `web-create-${crypto.randomUUID()}`, request: {
      tripId: crypto.randomUUID(), riderId: "11111111-1111-4111-8111-111111111112",
      serviceDate, serviceTimezone: "America/Los_Angeles", localServiceTime: "09:00:00",
      ...resolved, ambiguityPolicy: "reject",
    } };
    try { await api.create(pending.current.request, pending.current.key); pending.current = null; setMessage("Trip saved in cloud PostgreSQL."); await trips.refetch(); }
    catch (error) { report(error); }
    finally { setBusy(false); }
  };
  const cancel = async (tripId: string) => {
    if (busy || pending.current || (cancelPending.current && cancelPending.current.tripId !== tripId)) return;
    setBusy(true);
    try {
      if (!cancelPending.current) {
        const current = await api.read(tripId);
        if (!current.etag) throw new Error("ETAG_REQUIRED");
        cancelPending.current = { tripId, etag: current.etag, key: `web-cancel-${crypto.randomUUID()}` };
      }
      const command = cancelPending.current;
      await api.cancel(command.tripId, command.etag, command.key);
      cancelPending.current = null; setMessage("Cancellation confirmed by cloud backend."); await trips.refetch();
    } catch (error) {
      if (error instanceof DevelopmentApiError && error.status > 0 && error.code !== "OUTCOME_UNKNOWN") cancelPending.current = null;
      report(error);
    } finally { setBusy(false); }
  };
  return <main id="main-content" className="dispatch-page">
    <section className="page-title"><div><p className="eyebrow">Private cloud · Prototype · Synthetic data only</p><h1>Cloud trip workspace</h1>
      <p>These trips come from the retained backend. This is not the final Dispatch client.</p></div></section>
    <CloudCommandRecovery recovery={api.recovery} enabled={session.isSuccess}/>
    <CloudBoard api={api} enabled={session.isSuccess} serviceDate={serviceDate} onServiceDateChange={setServiceDate}/>
    <p>Facility status is available in the separate facility view. Tracking is synthetic only; real location remains disabled.</p>
    <section aria-label="Driver updates from cloud">
      <h2>Driver updates · {serviceDate}</h2>
      <p role="status">Cloud updates: {liveStatus}</p>
      <p>Recorded shift updates from dispatch. Live notifications trigger a server refresh, with a five-second fallback. These records do not indicate current tracking or shift completion.</p>
      {dispatchSnapshot.isPending && <p role="status">Loading Driver updates…</p>}
      {dispatchSnapshot.isError ? <p role="alert">Driver updates unavailable. Previously loaded updates may be stale.</p> : dispatchSnapshot.data && <>
        <ul>{dispatchSnapshot.data.value.resources.filter(item => item.kind === "driver-shift").map(item =>
          <li key={item.reference}>Shift recorded: <span>{item.reference}</span> · version {item.version}</li>)}</ul>
        {!dispatchSnapshot.data.value.resources.some(item => item.kind === "driver-shift") && <p>No recorded Driver updates for this service day.</p>}
      </>}
    </section>
    {session.isPending && <p role="status">Connecting to cloud session…</p>}
    {(session.isError || trips.isError) && <p role="alert">Cloud connection unavailable. Check the private tunnel. No local data fallback is active.</p>}
    <button disabled={!session.isSuccess || busy || !!cancelPending.current} onClick={() => void create()}>{pending.current ? "Retry pending create" : "Create synthetic cloud trip"}</button>
    <button disabled={!session.isSuccess || busy} onClick={() => void trips.refetch()}>Refresh from server</button>
    <p role="status">{message}</p>
    {(pending.current || cancelPending.current) && <p>Retry this original request, or use Command recovery after reloading. No replacement command is needed.</p>}
    {cancelPending.current && <button disabled={busy} onClick={() => void cancel(cancelPending.current!.tripId)}>Retry pending cancellation</button>}
    {trips.isPending && session.isSuccess && <p role="status">Loading persisted trips…</p>}
    {trips.data && <section aria-label="Persisted cloud trips"><table><thead><tr><th>Trip reference</th><th>Service date</th><th>State</th><th>Version</th><th>Action</th></tr></thead>
      <tbody>{trips.data.value.items.map((trip) => <tr key={trip.tripId}><td>{trip.tripId}</td><td>{trip.serviceDate}</td><td>{trip.lifecycle}</td><td>{trip.version}</td><td>
        <button disabled={trip.lifecycle !== "DRAFT" || busy || !!pending.current || !!cancelPending.current} onClick={() => { if (window.confirm("Cancel this synthetic cloud trip?")) void cancel(trip.tripId); }}>Cancel trip</button>
      </td></tr>)}</tbody></table>
      {trips.data.value.items.length === 0 && <p>No persisted trips on this page.</p>}
      <button disabled={!cursor || busy} onClick={() => setCursor(null)}>First page</button>
      <button disabled={!trips.data.value.nextCursor || busy} onClick={() => setCursor(trips.data!.value.nextCursor)}>Next page</button>
    </section>}
  </main>;
}
