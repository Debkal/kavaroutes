import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams, type LoaderFunctionArgs } from "react-router";
import { Button, ConfirmDialog } from "../design-system";
import type { BoardStatus, CommandState } from "../contracts";
import { SYNTHETIC_PRINCIPALS } from "../identity";
import { createGeneratedAssignmentClient } from "../generated-command-client";
import { createSyntheticMapPort, type MapState } from "../map-port";
import { useProjection } from "../projection-store";
import { queryKeys } from "../query-keys";
import { projectionStore, syntheticApi } from "../runtime";
import { SyntheticApiProblem, type FailureMode } from "../synthetic-api";

const ALLOWED_STATUS = new Set(["ALL", "SCHEDULED", "READY", "IN_PROGRESS", "LATE", "COMPLETED"]);
const ALLOWED_SORT = new Set(["TIME", "STATUS"]);
const ACCESSIBLE_PAGE_SIZE = 200;

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  for (const [name, value] of url.searchParams) {
    if (name === "status" && ALLOWED_STATUS.has(value)) continue;
    if (name === "sort" && ALLOWED_SORT.has(value)) continue;
    throw new Response("Invalid safe board context", { status: 400, statusText: "Invalid board context" });
  }
  return null;
}

function validateSearch(search: URLSearchParams) {
  const status = search.get("status") ?? "ALL";
  const sort = search.get("sort") ?? "TIME";
  return { status: ALLOWED_STATUS.has(status) ? status : "ALL", sort: ALLOWED_SORT.has(sort) ? sort : "TIME" } as const;
}

function CommandPanel(props: { readonly tripReference: string; readonly version: number; readonly onConfirmed: () => void }) {
  const [state, setState] = useState<CommandState>("IDLE");
  const [failure, setFailure] = useState<FailureMode>("NONE");
  const idempotency = useRef(`assign-${props.tripReference}-v${props.version}`);
  const client = useMemo(() => createGeneratedAssignmentClient(syntheticApi, SYNTHETIC_PRINCIPALS.dispatcherAlpha), []);
  const mutation = useMutation({
    mutationFn: () => client.assign({ tripReference: props.tripReference, driverLabel: "Driver 042", expectedVersion: props.version, idempotencyKey: idempotency.current }, failure),
    onMutate: () => setState("SUBMITTING"),
    onSuccess: (receipt) => {
      setState("ACCEPTED_AWAITING_PROJECTION");
      const authoritative = syntheticApi.snapshot().trips.find((trip) => trip.reference === receipt.tripReference);
      if (!authoritative) { setState("RECOVERY_REQUIRED"); return; }
      projectionStore.confirmAssignment(receipt.tripReference, authoritative.driverLabel ?? "Driver 042", receipt.nextVersion);
      setState("CONFIRMED"); props.onConfirmed();
    },
    onError: (error) => {
      if (error instanceof SyntheticApiProblem && (error.status === 409 || error.status === 412)) setState("CONFLICT");
      else if (error instanceof SyntheticApiProblem && error.code === "OUTCOME_UNKNOWN") setState("UNKNOWN");
      else setState("REJECTED");
    },
  });
  return <section aria-labelledby="command-heading" className="command-panel">
    <h3 id="command-heading">Assignment control</h3>
    <label>Test response <select value={failure} onChange={(event) => setFailure(event.target.value as FailureMode)}>
      <option value="NONE">Normal</option><option value="CONFLICT">Precondition conflict (412)</option><option value="CONFLICT_409">Assignment conflict (409)</option><option value="LOST_RESPONSE">Lost response</option><option value="FORBIDDEN">Forbidden</option><option value="INVALID">Invalid</option><option value="RATE_LIMITED">Rate limited</option><option value="SERVER_ERROR">Server error</option>
    </select></label>
    <ConfirmDialog title="Assign Driver 042?" confirmLabel="Confirm assignment" onConfirm={() => mutation.mutate()} trigger={<Button className="primary" isDisabled={state === "SUBMITTING" || state === "ACCEPTED_AWAITING_PROJECTION"}>Assign Driver 042</Button>}>
      <p>The board will change only after the authoritative projection confirms this command.</p>
    </ConfirmDialog>
    <p className={`command-state state-${state.toLowerCase()}`} role="status" aria-live="polite">{state.replaceAll("_", " ").toLowerCase()}</p>
    {(state === "UNKNOWN" || state === "CONFLICT") && <Button onPress={() => { projectionStore.replace(syntheticApi.snapshot()); setState("CONFIRMED"); }}>Recover authoritative state</Button>}
  </section>;
}

function SyntheticMap(props: { readonly selectedVehicle: string | null; readonly onSelect: (reference: string) => void }) {
  const projection = useProjection(projectionStore);
  const port = useMemo(() => createSyntheticMapPort(), []);
  const [mapState, setMapState] = useState<MapState>("READY");
  const snapshot = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  useEffect(() => { port.mount(); return () => port.unmount(); }, [port]);
  useEffect(() => { port.updatePositions(projection.positions); }, [port, projection.positions]);
  useEffect(() => { port.select(props.selectedVehicle); }, [port, props.selectedVehicle]);
  useEffect(() => { port.setState(mapState); }, [port, mapState]);
  return <section className="map-panel" aria-labelledby="map-heading">
    <div className="panel-heading"><div><p className="eyebrow">Synthetic adapter</p><h2 id="map-heading">Fleet map</h2></div><label>Map mode <select value={mapState} onChange={(event) => setMapState(event.target.value as MapState)}><option>READY</option><option>SLOW</option><option>UNAVAILABLE</option><option>ERROR</option><option>QUOTA_DEGRADED</option></select></label></div>
    {snapshot.state === "READY" || snapshot.state === "SLOW" ? <div className="synthetic-map" data-testid="synthetic-map" aria-label="Synthetic fleet map; all vehicles are also available in the list">
      {snapshot.markers.slice(0, 75).map((marker) => <button key={marker.vehicleReference} aria-label={`${marker.displayLabel}${marker.stale ? ", stale" : ""}`} className={`marker ${marker.stale ? "stale" : ""} ${snapshot.selectedReference === marker.vehicleReference ? "selected" : ""}`} style={{ left: `${marker.x}%`, top: `${marker.y}%` }} onClick={() => props.onSelect(marker.vehicleReference)}>{marker.stale ? "!" : "•"}</button>)}
      <span className="map-note">{snapshot.markers.length} synthetic positions · {snapshot.clusters} cluster inputs</span>
    </div> : <div className="map-fallback" role="status"><strong>Map unavailable.</strong><span>The dispatch table and assignment controls remain fully available.</span></div>}
  </section>;
}

export function Component() {
  const [search, setSearch] = useSearchParams();
  const safe = validateSearch(search);
  const projection = useProjection(projectionStore);
  const [selectedReference, setSelectedReference] = useState<string | null>(projection.trips[0]?.reference ?? null);
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const tableHeading = useRef<HTMLHeadingElement>(null);
  useQuery({ queryKey: queryKeys.board({ organizationReference: SYNTHETIC_PRINCIPALS.dispatcherAlpha.organizationReference, principalReference: SYNTHETIC_PRINCIPALS.dispatcherAlpha.reference, purpose: "DISPATCH_CONTROL", projection: "DAY_BOARD" }, projection.serviceDate), queryFn: ({ signal }) => syntheticApi.getDispatchDay(SYNTHETIC_PRINCIPALS.dispatcherAlpha, signal) });
  const trips = useMemo(() => projection.trips.filter((trip) => safe.status === "ALL" || trip.status === safe.status).toSorted((left, right) => safe.sort === "STATUS" ? left.status.localeCompare(right.status) || left.scheduledTime.localeCompare(right.scheduledTime) : left.scheduledTime.localeCompare(right.scheduledTime)), [projection.trips, safe.sort, safe.status]);
  const selected = projection.trips.find((trip) => trip.reference === selectedReference) ?? null;
  const counts = useMemo(() => ({ total: projection.trips.length, late: projection.trips.filter((trip) => trip.status === "LATE").length, unassigned: projection.trips.filter((trip) => !trip.driverLabel).length }), [projection.trips]);
  const updateSearch = (name: "status" | "sort", value: string) => { const next = new URLSearchParams(search); next.set(name, value); setSearch(next, { replace: true }); };
  return <main id="main-content" className="dispatch-page">
    <section className="page-title"><div><p className="eyebrow">Dispatch control · Synthetic service day</p><h1>Today’s operations</h1><p>Friday, August 28 · Pacific service time</p></div><div data-testid="connection-state" className={`connection connection-${projection.connection.toLowerCase()}`} role="status" aria-live="polite"><span aria-hidden="true">●</span>{projection.connection.replaceAll("_", " ").toLowerCase()}</div></section>
    <section className="summary-grid" aria-label="Board summary"><article><span>Trips</span><strong>{counts.total}</strong></article><article><span>Need attention</span><strong>{counts.late}</strong></article><article><span>Unassigned</span><strong>{counts.unassigned}</strong></article><article><span>Vehicles visible</span><strong>{projection.positions.length}</strong></article></section>
    <section className="filters" aria-label="Board controls"><label>Status <select value={safe.status} onChange={(event) => updateSearch("status", event.target.value)}>{["ALL", "SCHEDULED", "READY", "IN_PROGRESS", "LATE", "COMPLETED"].map((status) => <option key={status}>{status}</option>)}</select></label><label>Sort <select value={safe.sort} onChange={(event) => updateSearch("sort", event.target.value)}><option value="TIME">Scheduled time</option><option value="STATUS">Status</option></select></label><Button onPress={() => projectionStore.setConnection(projection.connection === "LIVE" ? "DISCONNECTED" : "LIVE")}>{projection.connection === "LIVE" ? "Simulate disconnect" : "Reconnect"}</Button></section>
    <div className="workspace-grid">
      <section className="board-panel" aria-labelledby="board-heading"><div className="panel-heading"><div><p className="eyebrow">Authoritative day projection</p><h2 id="board-heading" ref={tableHeading}>Trip board</h2></div><span>{trips.length} shown</span></div>
        <div className="table-scroll" tabIndex={0} aria-label="Scrollable trip board"><table><thead><tr><th scope="col">Time</th><th scope="col">Rider</th><th scope="col">Route</th><th scope="col">Status</th><th scope="col">Driver / vehicle</th></tr></thead><tbody>{trips.slice(0, ACCESSIBLE_PAGE_SIZE).map((trip) => <tr key={trip.reference} className={selectedReference === trip.reference ? "selected-row" : ""}><td><button className="row-select" onClick={() => setSelectedReference(trip.reference)} aria-label={`Open ${trip.riderLabel} at ${trip.scheduledTime}`}>{trip.scheduledTime}</button></td><td>{trip.riderLabel}</td><td><span>{trip.pickupLabel}</span><span className="route-arrow" aria-hidden="true">→</span><span>{trip.dropoffLabel}</span></td><td><span className={`status status-${trip.status.toLowerCase()}`}>{trip.status.replaceAll("_", " ")}</span></td><td>{trip.driverLabel ? <><span>{trip.driverLabel}</span><small>{trip.vehicleLabel}</small></> : <span className="unassigned">Unassigned</span>}</td></tr>)}</tbody></table></div>
        {trips.length > ACCESSIBLE_PAGE_SIZE && <p className="paged-note">Showing the first {ACCESSIBLE_PAGE_SIZE} rows in this accessible page. Narrow the filter to review more.</p>}
      </section>
      <SyntheticMap selectedVehicle={selectedVehicle} onSelect={setSelectedVehicle} />
    </div>
    {selected && <aside className="detail-drawer" aria-labelledby="detail-heading"><div><p className="eyebrow">Selected trip</p><h2 id="detail-heading">{selected.riderLabel}</h2><p>{selected.scheduledTime} · {selected.pickupLabel} to {selected.dropoffLabel}</p><dl><div><dt>Status</dt><dd>{selected.status.replaceAll("_", " ")}</dd></div><div><dt>Assignment</dt><dd>{selected.driverLabel ?? "Not assigned"}</dd></div><div><dt>Projection version</dt><dd>{selected.version}</dd></div></dl></div><CommandPanel key={selected.reference} tripReference={selected.reference} version={selected.version} onConfirmed={() => tableHeading.current?.focus()} /><Button aria-label="Close trip details" onPress={() => { setSelectedReference(null); tableHeading.current?.focus(); }}>Close</Button></aside>}
  </main>;
}
