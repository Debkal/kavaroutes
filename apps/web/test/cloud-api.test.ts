import { describe, expect, it, vi } from "vitest";
import {webcrypto} from 'node:crypto';
import { createCloudApi } from "../src/cloud-api";
import type { DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";

const trip = { tripId: "10000000-0000-4000-8000-000000000010", riderReference: "11111111-1111-4111-8111-111111111112", serviceDate: "2026-09-13", serviceTimezone: "America/Los_Angeles", resolvedServiceAt: "2026-09-13T16:00:00.000Z", lifecycle: "DRAFT", version: 1 };
const response = (body: unknown, status = 200) => ({ status, headers: { get: () => '"server-etag"' }, json: async () => body });
describe("private cloud web adapter", () => {
  it("reads persisted Driver updates and rejects unexpected projection fields", async () => {
    const delta = { kind: "RESOURCE_INVALIDATED", resourceKind: "driver-shift",
      resourceReference: "driver-shift:ff8cc83f-baba-47bf-a636-11132bac1262", resourceVersion: 1 };
    const body = { cursor: `rtc1.${"a".repeat(48)}`, etag: '"snapshot"', projection: { shift: delta } };
    const api = createCloudApi("http://127.0.0.1:4311", async () => response(body));
    expect((await api.dispatchSnapshot("2026-09-13")).value.resources).toEqual([
      { kind: "driver-shift", reference: delta.resourceReference, version: 1 },
    ]);
    const malformed = createCloudApi("http://127.0.0.1:4311", async () => response({ ...body,
      projection: { shift: { ...delta, patientName: "forbidden" } } }));
    await expect(malformed.dispatchSnapshot("2026-09-13")).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
  it("reads the remote trip collection and preserves cursor", async () => {
    const fetcher: DevelopmentFetch = async (url, init) => {
      expect(url).toContain("/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/trips?limit=50");
      expect(init.headers.authorization).toBe("Synthetic principal_dispatcher");
      return response({ items: [trip], page: { nextCursor: "opaque-cursor" } });
    };
    expect((await createCloudApi("http://127.0.0.1:4311", fetcher).list()).value).toEqual({ items: [trip], nextCursor: "opaque-cursor" });
  });
  it("rejects a mismatched cancellation receipt", async () => {
    vi.stubGlobal('crypto',webcrypto);let prepared:any,executed=false;
    const api = createCloudApi("http://127.0.0.1:4311", async (url,init) => {
      if(!url.endsWith('/execute')){prepared={...JSON.parse(init.body!),expired:false,acknowledged:false,result:null};return response(prepared);}
      executed=true;return response({...prepared,result:{outcome:'ACCEPTED',statusCode:200,etag:null,body:{trip:{...trip,lifecycle:'CANCELLED'},receipt:{outcome:'APPLIED',resourceVersion:99}}}});
    });
    try{await expect(api.cancel(trip.tripId, '"kr1.'+'A'.repeat(43)+'"', "stable-key")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });expect(executed).toBe(true);}finally{vi.unstubAllGlobals();}
  });
  it("does not turn cloud failure into fixture data", async () => {
    const api = createCloudApi("http://127.0.0.1:4311", async () => response({}, 503));
    await expect(api.list()).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });
  it("requires membership and capability from server session", async () => {
    const api = createCloudApi("http://127.0.0.1:4311", async () => response({ principalKind: "SYNTHETIC_USER", organizations: [{ organizationId: "other-tenant", capabilities: ["trips:read"] }] }));
    await expect(api.authenticate()).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
});
