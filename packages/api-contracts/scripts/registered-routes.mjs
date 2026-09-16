// Single definition of the registered API surface. The OpenAPI document, the
// route matrix and the operation catalog are all generated from this module so
// the three artifacts cannot disagree about which operations exist.
import { createWp007Api } from "../dist/index.js";

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

/** Compose the registered API and return its canonical OpenAPI document. */
export async function registeredApiDocument() {
  const app = await createWp007Api({ requestIdFactory: () => "req_wp007_generation", now: () => new Date("2026-08-24T12:00:00.000Z") });
  await app.ready();
  const document = app.swagger();
  const tripDetail = document.paths["/v1/organizations/{organizationId}/trips/{tripId}"];
  if (!tripDetail?.get) throw new Error("REGISTERED_TRIP_DETAIL_ROUTE_REQUIRED");
  tripDetail.head = structuredClone(tripDetail.get);
  tripDetail.head.operationId = "headTrip";
  tripDetail.head.responses["200"] = {
    description: "Trip headers",
    headers: tripDetail.get.responses["200"].headers,
  };
  await app.close();
  return canonical(document);
}

/** Registered operations in the order the route matrix records them. */
export function registeredRoutes(document) {
  const routes = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ["get", "head", "post", "put", "delete"]) {
      if (pathItem[method]) routes.push({ method: method.toUpperCase(), path, operationId: pathItem[method].operationId,
        statuses: Object.keys(pathItem[method].responses).sort(), security: pathItem[method].security ?? [] });
    }
  }
  routes.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
  return routes;
}
