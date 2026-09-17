import {createPrivateDevelopmentTransport,type DevelopmentFetch} from "@kavaroutes/api-contracts/private-development-transport";

/** Dispatch-authored client intake. A client carries the trip pattern it books: one
 * pickup address, one or more drop-off addresses and ONE_WAY or ROUND_TRIP. The
 * roster and the create command are the dispatcher surface only. */
export const clientOrganizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = `/v1/organizations/${clientOrganizationId}/clients`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CLIENT_RESPONSE");
  return value as Record<string, unknown>;
};
const keysAre = (value: Record<string, unknown>, expected: readonly string[]) => {
  if (Object.keys(value).sort().join() !== [...expected].sort().join()) throw new Error("INVALID_CLIENT_RESPONSE");
};
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error("INVALID_CLIENT_RESPONSE");
  return value;
};
const nullableText = (value: unknown, max: number) => value === null ? null : text(value, max);
const serviceDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_CLIENT_RESPONSE");
  return value;
};
const tripType = (value: unknown) => {
  if (value === "ONE_WAY" || value === "ROUND_TRIP") return value;
  throw new Error("INVALID_CLIENT_RESPONSE");
};

export type ClientTripType = "ONE_WAY" | "ROUND_TRIP";
export interface ClientRoute { readonly tripId: string; readonly serviceDate: string }
export interface ClientDropoff { readonly ordinal: number; readonly addressLabel: string }
export interface ClientRecord {
  readonly clientId: string; readonly displayName: string; readonly entityName: string | null;
  readonly phone: string | null; readonly pickupAddress: string | null; readonly dropoffAddresses: readonly ClientDropoff[];
  readonly tripType: ClientTripType | null; readonly notes: string | null;
  readonly version: number; readonly routes: readonly ClientRoute[];
}
export interface ClientUpdateRequest {
  readonly displayName: string; readonly entityName?: string | null; readonly phone?: string | null;
  readonly pickupAddress?: string | null; readonly tripType?: ClientTripType | null; readonly notes?: string | null;
  readonly addDropoffAddresses?: readonly string[];
}
export interface ClientCreateRequest {
  readonly displayName: string; readonly entityName?: string | null; readonly phone?: string | null;
  readonly pickupAddress?: string | null; readonly dropoffAddresses?: readonly string[];
  readonly tripType?: ClientTripType | null; readonly notes?: string | null;
}
export interface ClientCreateReceipt { readonly clientId: string; readonly version: number; readonly displayName: string; readonly dropoffCount: number }

export function decodeClientRecord(value: unknown): ClientRecord {
  const source = object(value);
  keysAre(source, ["clientId", "displayName", "entityName", "phone", "pickupAddress", "dropoffAddresses", "tripType", "notes", "version", "routes"]);
  if (typeof source.clientId !== "string" || !uuid.test(source.clientId) || !Number.isSafeInteger(source.version) || Number(source.version) < 1) throw new Error("INVALID_CLIENT_RESPONSE");
  if (!Array.isArray(source.dropoffAddresses) || source.dropoffAddresses.length > 20) throw new Error("INVALID_CLIENT_RESPONSE");
  if (!Array.isArray(source.routes) || source.routes.length > 25) throw new Error("INVALID_CLIENT_RESPONSE");
  const dropoffs = source.dropoffAddresses.map(entry => {
    const dropoff = object(entry);
    keysAre(dropoff, ["ordinal", "addressLabel"]);
    if (!Number.isSafeInteger(dropoff.ordinal) || Number(dropoff.ordinal) < 1 || Number(dropoff.ordinal) > 20) throw new Error("INVALID_CLIENT_RESPONSE");
    return {ordinal: Number(dropoff.ordinal), addressLabel: text(dropoff.addressLabel, 512)};
  });
  const routes = source.routes.map(entry => {
    const route = object(entry);
    keysAre(route, ["tripId", "serviceDate"]);
    if (typeof route.tripId !== "string" || !uuid.test(route.tripId)) throw new Error("INVALID_CLIENT_RESPONSE");
    return {tripId: route.tripId, serviceDate: serviceDate(route.serviceDate)};
  });
  return {
    clientId: source.clientId, displayName: text(source.displayName, 200),
    entityName: nullableText(source.entityName, 200), phone: nullableText(source.phone, 40),
    pickupAddress: nullableText(source.pickupAddress, 512), dropoffAddresses: dropoffs,
    tripType: source.tripType === null ? null : tripType(source.tripType),
    notes: nullableText(source.notes, 2000), version: Number(source.version), routes,
  };
}

export function decodeClientRoster(value: unknown) {
  const source = object(value);
  keysAre(source, ["clients", "nextAfter"]);
  if (!Array.isArray(source.clients) || source.clients.length > 200) throw new Error("INVALID_CLIENT_RESPONSE");
  if (source.nextAfter !== null && (typeof source.nextAfter !== "string" || !uuid.test(source.nextAfter))) throw new Error("INVALID_CLIENT_RESPONSE");
  return {clients: source.clients.map(decodeClientRecord), nextAfter: source.nextAfter as string | null};
}

/** One canonical wire shape: the trip pattern. A roster that still carries the older
 * home-only record is mapped onto it instead of failing, so a client build and the
 * server can never disagree about which shape is "current". */
const decodeReceipt = (value: unknown): ClientCreateReceipt => {
  const source = object(value);
  keysAre(source, ["clientId", "version", "displayName", "dropoffCount"]);
  if (typeof source.clientId !== "string" || !uuid.test(source.clientId) || !Number.isSafeInteger(source.version) || Number(source.version) < 1 ||
    !Number.isSafeInteger(source.dropoffCount) || Number(source.dropoffCount) < 0 || Number(source.dropoffCount) > 20) throw new Error("INVALID_CLIENT_RECEIPT");
  return {clientId: source.clientId, version: Number(source.version), displayName: text(source.displayName, 200), dropoffCount: Number(source.dropoffCount)};
};

export function createCloudClientApi(baseUrl: string, fetcher: DevelopmentFetch) {
  const transport = createPrivateDevelopmentTransport({baseUrl, persona: "dispatcher", fetch: fetcher, browserSameOrigin: new URL(baseUrl).protocol === "https:"});
  const body = (request: ClientCreateRequest) => {
    const value: Record<string, unknown> = {displayName: request.displayName};
    for (const field of ["entityName", "phone", "pickupAddress", "notes"] as const) {
      const entry = request[field];
      if (entry !== undefined && entry !== null && entry !== "") value[field] = entry;
    }
    if (request.dropoffAddresses?.length) value.dropoffAddresses = [...request.dropoffAddresses];
    if (request.tripType) value.tripType = request.tripType;
    return value;
  };
  const decodeRecord = (value: unknown): ClientRecord => {
    const source = object(value);
    // Older server build: one address label, no destinations, no trip type.
    if (!("pickupAddress" in source) && "addressLabel" in source) {
      const {addressLabel, ...rest} = source;
      return decodeClientRecord({...rest, pickupAddress: addressLabel, dropoffAddresses: [], tripType: null});
    }
    return decodeClientRecord(source);
  };
  const decodeRoster = (value: unknown) => {
    const source = object(value);
    keysAre(source, ["clients", "nextAfter"]);
    if (!Array.isArray(source.clients) || source.clients.length > 200) throw new Error("INVALID_CLIENT_RESPONSE");
    if (source.nextAfter !== null && (typeof source.nextAfter !== "string" || !uuid.test(source.nextAfter))) throw new Error("INVALID_CLIENT_RESPONSE");
    return {clients: source.clients.map(decodeRecord), nextAfter: source.nextAfter as string | null};
  };
  return Object.freeze({
    async authenticate(signal?: AbortSignal) {
      return transport.request("/v1/me", value => {
        const source = object(value);
        if (source.principalKind !== "SYNTHETIC_USER" || !Array.isArray(source.organizations)) throw new Error("INVALID_CLIENT_SESSION");
        const membership = source.organizations.map(object).find(item => item.organizationId === clientOrganizationId);
        if (!membership || !Array.isArray(membership.capabilities) || !membership.capabilities.includes("trips:read")) throw new Error("INVALID_CLIENT_SESSION");
        return {principalId: String(source.principalId), organizationId: clientOrganizationId};
      }, undefined, signal);
    },
    roster(clientId?: string, signal?: AbortSignal) {
      if (clientId !== undefined && !uuid.test(clientId)) throw new Error("INVALID_CLIENT_REFERENCE");
      const query = clientId === undefined ? "" : `?clientId=${clientId}`;
      return transport.request(`${prefix}${query}`, decodeRoster, undefined, signal);
    },
    /** Correct a client record. Operator fields are replaced; drop-offs are appended
     * because the recorded pattern stays append-only. */
    update(clientId: string, request: ClientUpdateRequest, key: string) {
      if (!uuid.test(clientId)) throw new Error("INVALID_CLIENT_REFERENCE");
      text(request.displayName, 200);
      const value = body(request);
      if (request.addDropoffAddresses?.length) value.addDropoffAddresses = [...request.addDropoffAddresses];
      return transport.request(`${prefix}/${clientId}/commands/update`, decodeReceipt, {body: value, idempotencyKey: key});
    },
    create(request: ClientCreateRequest, key: string) {
      text(request.displayName, 200);
      return transport.request(`${prefix}/commands/create`, value => {
        const source = object(value);
        // The receipt names the destinations the server stored. An older server build
        // omits the count, which means none were stored.
        const dropoffCount = "dropoffCount" in source ? source.dropoffCount : 0;
        keysAre(source, "dropoffCount" in source ? ["clientId", "version", "displayName", "dropoffCount"] : ["clientId", "version", "displayName"]);
        if (typeof source.clientId !== "string" || !uuid.test(source.clientId) || !Number.isSafeInteger(source.version) || Number(source.version) < 1 ||
          !Number.isSafeInteger(dropoffCount) || Number(dropoffCount) < 0 || Number(dropoffCount) > 20) throw new Error("INVALID_CLIENT_RECEIPT");
        return {clientId: source.clientId, version: Number(source.version), displayName: text(source.displayName, 200), dropoffCount: Number(dropoffCount)};
      }, {body: body(request), idempotencyKey: key});
    },
  });
}
