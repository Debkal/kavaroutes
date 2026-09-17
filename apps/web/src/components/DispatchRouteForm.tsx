import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";
import type { createCloudApi } from "../cloud-api";
import type { CloudPlanRequest } from "../cloud-board-contract";
import { createCloudClientApi } from "../cloud-client-api";
import { resolveLocalServiceStart } from "../cloud-service-time";
import {businessTimezone,businessTimezoneLabel} from "../business-time";
import {ServiceDatePicker} from "./ServiceDatePicker";

/** A dispatcher-authored run. The form only collects what the server records:
 * civil service time, addresses and proof requirements. It never invents an
 * offset, a capacity or a driver; those stay with the persisted authority. */
type LegDraft = {
  riderReference: string; pickupLabel: string; dropoffLabel: string;
  localTime: string; durationMinutes: string;
  pickupRequired: boolean; dropoffRequired: boolean; mobilitySecurementRequired: boolean;
  /** The trip pattern the run expresses: one way, or out and back to the pickup. */
  tripType?: "ONE_WAY" | "ROUND_TRIP";
  /** Marks the leg the form generated as the return of a round trip. */
  generatedReturn?: boolean;
};
const MAX_LEGS = 6, MIN_DURATION_MINUTES = 5, MAX_DURATION_MINUTES = 240, RUN_PADDING_MINUTES = 15;
const emptyLeg = (): LegDraft => ({
  riderReference: "Synthetic Rider", pickupLabel: "", dropoffLabel: "",
  localTime: "09:00", durationMinutes: "45",
  pickupRequired: true, dropoffRequired: true, mobilitySecurementRequired: false,
});
const trimmed = (value: string, label: string) => {
  const text = value.trim();
  if (!text || text.length > 512) throw new Error(`Enter a ${label} of 1 to 512 characters.`);
  return text;
};

export function DispatchRouteForm({ api, serviceDate, onServiceDateChange, onPlanned, initialClientId=null }: {
  api: ReturnType<typeof createCloudApi>; serviceDate: string;
  onServiceDateChange: (value: string) => void; onPlanned?: (runId: string) => void; initialClientId?:string|null;
}) {
  // The client roster is its own dispatch-scoped transport. A failed read leaves the
  // picker empty and says so; it never blocks a run that is entered without a client.
  const clientApi = useRef(createCloudClientApi(window.location.origin, window.fetch.bind(window)));
  const [clientId, setClientId] = useState("");
  const clients = useQuery({ queryKey: ["private-cloud", "clients", "plan-picker"], queryFn: ({ signal }) => clientApi.current.roster(undefined, signal), retry: false });
  const timezone = businessTimezone;
  const [legs, setLegs] = useState<LegDraft[]>([emptyLeg()]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // Held in tab memory only, so a retry replays the identical command.
  const pending = useRef<{ request: CloudPlanRequest; key: string } | null>(null);
  const initialized=useRef(false);
  useEffect(()=>{
    if(initialized.current||!initialClientId||!clients.data)return;
    initialized.current=true;
    const client=clients.data.value.clients.find(item=>item.clientId===initialClientId);
    if(!client){setMessage("This client is no longer available. Select an accessible client before scheduling.");return;}
    setClientId(client.clientId);
    setLegs([{...emptyLeg(),riderReference:client.displayName,pickupLabel:client.pickupAddress??""}]);
  },[initialClientId,clients.data]);
  // Edits run through the return generator, so a round trip's return leg always
  // mirrors the outbound leg it belongs to.
  const patch = (index: number, change: Partial<LegDraft>) =>
    setLegs(current => syncReturns(current.map((leg, position) => position === index ? { ...leg, ...change } : leg)));

  const build = (): CloudPlanRequest => {
    const resolved = legs.map(leg => {
      const duration = Number(leg.durationMinutes);
      if (!Number.isInteger(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES)
        throw new Error(`Each leg needs a duration between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`);
      const start = resolveLocalServiceStart(serviceDate, leg.localTime, timezone);
      return { leg, duration, start };
    });
    const legRequests = resolved.map(({ leg, duration, start }) => ({
      riderReference: trimmed(leg.riderReference, "rider reference"),
      pickupLabel: trimmed(leg.pickupLabel, "pickup address"),
      dropoffLabel: trimmed(leg.dropoffLabel, "drop-off address"),
      // The server stores the civil reading and the instant together, and checks
      // that a leg's resolved service instant equals its planned start.
      localServiceTime: `${leg.localTime}:00`,
      resolvedServiceAt: start.instant,
      resolvedUtcOffsetSeconds: start.offsetSeconds,
      plannedStartAt: start.instant,
      plannedEndAt: new Date(Date.parse(start.instant) + duration * 60_000).toISOString(),
      pickupRequired: leg.pickupRequired,
      dropoffRequired: leg.dropoffRequired,
      mobilitySecurementRequired: leg.mobilitySecurementRequired,
    }));
    const starts = legRequests.map(leg => Date.parse(leg.plannedStartAt));
    const ends = legRequests.map(leg => Date.parse(leg.plannedEndAt));
    return {
      serviceDate, serviceTimezone: timezone,
      plannedStartAt: new Date(Math.min(...starts) - RUN_PADDING_MINUTES * 60_000).toISOString(),
      plannedEndAt: new Date(Math.max(...ends) + RUN_PADDING_MINUTES * 60_000).toISOString(),
      seatsRequired: 1, wheelchairSpacesRequired: 0, legs: legRequests,
      ...(clientId ? { clientId } : {}),
    };
  };

  // A round trip is expressed as a return leg whose pickup and drop-off are the
  // outbound leg reversed; keeping it generated means the operator cannot enter a
  // return that does not match the trip it belongs to.
  const syncReturns = (current: LegDraft[]): LegDraft[] => {
    const withoutReturns = current.filter(leg => !leg.generatedReturn);
    const returns = withoutReturns.filter(leg => leg.tripType === "ROUND_TRIP").map(leg => ({
      ...leg, generatedReturn: true,
      pickupLabel: leg.dropoffLabel, dropoffLabel: leg.pickupLabel,
      localTime: returnClock(leg.localTime, leg.durationMinutes),
    }));
    return [...withoutReturns, ...returns];
  };
  const returnClock = (localTime: string, durationMinutes: string) => {
    const [hours, minutes] = localTime.split(":").map(Number);
    const start = (hours ?? 9) * 60 + (minutes ?? 0) + (Number(durationMinutes) || 45);
    return `${String(Math.floor((start % 1440) / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
  };
  const setTripType = (index: number, tripType: "ONE_WAY" | "ROUND_TRIP") =>
    setLegs(current => syncReturns(current.map((leg, position) => position === index ? { ...leg, tripType } : leg)));
  // One trip carries one pickup and one drop-off in this model, so a second stop for
  // the same pickup is a second trip. The control says that instead of implying a
  // multi-stop trip the server cannot plan (audit WEB-A-030).
  const addTripFromThisPickup = (index: number) =>
    setLegs(current => syncReturns([...current, { ...current[index]!, dropoffLabel: "", generatedReturn: false }]));
  const plan = async () => {
    if (busy) return;
    if (!pending.current) {
      try { pending.current = { request: build(), key: `web-plan-${crypto.randomUUID()}` }; }
      catch (error) { setMessage(error instanceof Error ? error.message : "Review the route fields."); return; }
    }
    setBusy(true); setMessage("Submitting the route to the server…");
    try {
      const receipt = await api.planRun(pending.current.request, pending.current.key);
      pending.current = null;
      setLegs([emptyLeg()]);
      setClientId("");
      setMessage(`Transport scheduled with ${receipt.value.legCount} trip(s). Assign a driver and vehicle on the Dispatch board below.`);
      onPlanned?.(receipt.value.runId);
    } catch (error) {
      if (error instanceof DevelopmentApiError && error.status >= 400 && error.status < 500 && error.code !== "OUTCOME_UNKNOWN") {
        const code = error.code;
        pending.current = null;
        setMessage(code === "REQUEST_CONFLICT" ? "The server rejected this route. Check the service date and leg windows, then resubmit." : `Route rejected: ${code.replaceAll("_", " ").toLowerCase()}.`);
      } else setMessage("Outcome unknown. The server may already have saved this run. Retry the original plan here, or refresh the board and look for it before entering another route.");
    } finally { setBusy(false); }
  };

  return <section aria-label="Enter a route for the driver">
    <h2>Schedule transport</h2>
    <p>Choose a client, confirm pickup, and enter the requested destination. Assign a driver and vehicle on the board after saving.</p>
    <ServiceDatePicker value={serviceDate} disabled={busy || !!pending.current} onChange={onServiceDateChange}/>
    <p className="form-hint">All appointment times use {businessTimezoneLabel}, the configured business timezone.</p>
    <label>Client <select value={clientId} disabled={busy || !!pending.current} onChange={event => {
      initialized.current=true;
      const id=event.target.value; setClientId(id);
      const client=clients.data?.value.clients.find(item=>item.clientId===id);
      if(client)setLegs([{...emptyLeg(),riderReference:client.displayName,pickupLabel:client.pickupAddress??""}]);
      else setLegs([emptyLeg()]);
    }}>
      <option value="">Choose a client or enter details below</option>
      {(clients.data?.value.clients ?? []).map(client => <option key={client.clientId} value={client.clientId}>{client.displayName}</option>)}
    </select></label>
    {clients.isError && <p role="alert">Client roster unavailable. The run can still be planned without a client; add clients on the Clients page.</p>}
    <ol className="plan-legs">{legs.map((leg, index) => <li key={index}>
      <fieldset disabled={busy || !!pending.current}>
        <legend>{leg.generatedReturn ? `Return trip ${index + 1} (generated from its outbound leg)` : `Trip ${index + 1}`}</legend>
        <label>Client name <input value={leg.riderReference} onChange={event => patch(index, { riderReference: event.target.value })}/></label>
        <label>Pickup address <input value={leg.pickupLabel} onChange={event => patch(index, { pickupLabel: event.target.value })}/></label>
        <label>Drop-off address <input value={leg.dropoffLabel} onChange={event => patch(index, { dropoffLabel: event.target.value })}/></label>
        {!leg.generatedReturn && <label>Trip type <select value={leg.tripType ?? "ONE_WAY"} onChange={event => setTripType(index, event.target.value as "ONE_WAY" | "ROUND_TRIP")}>
          <option value="ONE_WAY">One way</option>
          <option value="ROUND_TRIP">Round trip (returns to the pickup)</option>
        </select></label>}
        <label>Pickup time <input type="time" value={leg.localTime} onChange={event => patch(index, { localTime: event.target.value })}/></label>
        <label>Estimated trip duration (minutes) <input type="number" min={MIN_DURATION_MINUTES} max={MAX_DURATION_MINUTES} value={leg.durationMinutes} onChange={event => patch(index, { durationMinutes: event.target.value })}/></label>
        <label><input type="checkbox" checked={leg.pickupRequired} onChange={event => patch(index, { pickupRequired: event.target.checked })}/> Pickup signature required</label>
        <label><input type="checkbox" checked={leg.dropoffRequired} onChange={event => patch(index, { dropoffRequired: event.target.checked })}/> Drop-off signature required</label>
        <label><input type="checkbox" checked={leg.mobilitySecurementRequired} onChange={event => patch(index, { mobilitySecurementRequired: event.target.checked })}/> Mobility securement required</label>
        {!leg.generatedReturn && <button disabled={busy || !!pending.current || legs.length >= MAX_LEGS} onClick={() => addTripFromThisPickup(index)}>Add another trip from this pickup</button>}
      </fieldset>
      {legs.length > 1 && <button disabled={busy || !!pending.current} onClick={() => setLegs(current => syncReturns(current.filter((_, position) => position !== index)))}>Remove trip {index + 1}</button>}
    </li>)}</ol>
    <button disabled={busy || !!pending.current || legs.length >= MAX_LEGS} onClick={() => setLegs(current => [...current, emptyLeg()])}>Add a blank trip</button>
    <p className="form-hint">Each trip carries one pickup address and one drop-off address. A client's recorded drop-off addresses live on the Clients page; schedule one trip per drop-off you are covering today.</p>
    <button className="primary" disabled={busy || !serviceDate} onClick={() => void plan()}>{pending.current ? "Retry the original plan" : "Save route for the driver"}</button>
    <p role="status">{message}</p>
    {pending.current && <p>This tab still holds the original request. Retrying it replays the same command; it does not plan a second run.</p>}
  </section>;
}
