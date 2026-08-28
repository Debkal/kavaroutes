import { useQuery } from "@tanstack/react-query";
import type { LoaderFunctionArgs } from "react-router";
import { SYNTHETIC_PRINCIPALS } from "../identity";
import { queryKeys } from "../query-keys";
import { syntheticApi } from "../runtime";

export function loader({ request }: LoaderFunctionArgs) {
  if (new URL(request.url).search !== "") throw new Response("Facility route accepts no URL context", { status: 400, statusText: "Invalid facility context" });
  return null;
}

export function Component() {
  const principal = SYNTHETIC_PRINCIPALS.facilityAlpha;
  const facilityReference = principal.facilityReference ?? "";
  const result = useQuery({ queryKey: queryKeys.board({ organizationReference: principal.organizationReference, principalReference: principal.reference, purpose: "FACILITY_COORDINATION", projection: "FACILITY_DAY" }, "2026-08-28"), queryFn: ({ signal }) => syntheticApi.getFacilityDay(principal, facilityReference, signal) });
  return <main id="main-content" className="facility-page"><section className="page-title"><div><p className="eyebrow">KavaRoutes Connect · Synthetic facility</p><h1>Today’s arrivals</h1><p>Minimum-necessary coordination view</p></div></section>
    {result.isPending && <p role="status">Loading facility trips…</p>}
    {result.isError && <p role="alert">Facility view is unavailable.</p>}
    {result.data && <section className="facility-list" aria-labelledby="facility-list-heading"><h2 id="facility-list-heading">Scheduled trips</h2><ul>{result.data.trips.slice(0, 40).map((trip) => <li key={trip.reference}><time>{trip.scheduledTime}</time><div><strong>{trip.riderLabel}</strong><span>{trip.status.replaceAll("_", " ")} · ETA precision: 15-minute window</span></div></li>)}</ul><p className="privacy-note">This view does not request fleet positions, driver availability, breadcrumbs, billing, claims, or administration data.</p></section>}
  </main>;
}
