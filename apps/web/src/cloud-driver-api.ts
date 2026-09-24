import {
  decodeEffectiveDriverPolicy,
  type BatchReceipt,
  type DriverActionBatch,
  type DriverActionItem,
  type DriverClosureReceipt,
  type DriverClosureRequest,
  type DriverClosureView,
  type DriverItinerary,
  type DriverPrecheckReceipt,
  type DriverPrecheckRequest,
  type DriverShiftState,
  type DriverSignatureReceipt,
  type DriverSignatureRequest,
  type StartDriverShiftReceipt,
} from "@kavaroutes/api-contracts/client-web";
import { createPrivateDevelopmentTransport, type DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";
import {decodeDriverRoadRoute} from './road-route-contract';
import type { DriverLocationBatchRequest, DriverLocationReceipt } from "@kavaroutes/api-contracts";

export const driverOrganizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type DriverLocationBatchReceipt = DriverLocationReceipt;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_DRIVER_RESPONSE");
  return value as Record<string, unknown>;
};

export function decodeDriverItinerary(value: unknown, driverId: string): DriverItinerary {
  const source = object(value);
  if (source.driverReference !== driverId || typeof source.serviceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(source.serviceDate) || !Array.isArray(source.legs) || source.legs.length > 500) throw new Error("INVALID_DRIVER_ITINERARY");
  for (const raw of source.legs) {
    const leg = object(raw);
    if (![leg.assignmentId, leg.runId, leg.tripId, leg.tripLegId].every(value => typeof value === "string" && uuid.test(value)) ||
      !Number.isSafeInteger(leg.assignmentVersion) || !Number.isSafeInteger(leg.runVersion) || !Number.isSafeInteger(leg.ordinal) ||
      (leg.appointmentLengthMinutes!==undefined&&(!Number.isSafeInteger(leg.appointmentLengthMinutes) || Number(leg.appointmentLengthMinutes)<0 || Number(leg.appointmentLengthMinutes)>1440)) ||
      [leg.riderLabel, leg.pickupLabel, leg.dropoffLabel, leg.plannedStartAt, leg.plannedEndAt, leg.serviceTimezone].some(value => typeof value !== "string")) throw new Error("INVALID_DRIVER_ITINERARY");
    if (leg.execution !== undefined && leg.execution !== null) {
      const execution = object(leg.execution);
      if (typeof execution.executionId !== "string" || !uuid.test(execution.executionId) || typeof execution.lifecycle !== "string" || !Number.isSafeInteger(execution.version)) throw new Error("INVALID_DRIVER_ITINERARY");
      if (execution.expectedTag !== undefined && typeof execution.expectedTag !== "string") throw new Error("INVALID_DRIVER_ITINERARY");
    }
  }
  return source as unknown as DriverItinerary;
}

function decodeShift(value: unknown, assignmentId: string, driverId: string): DriverShiftState {
  const source = object(value);
  if (typeof source.shiftReference !== "string" || !uuid.test(source.shiftReference) || typeof source.shiftGeneration !== "string" || !uuid.test(source.shiftGeneration) ||
    !Number.isSafeInteger(source.resourceVersion) || !Number.isSafeInteger(source.lastActionSequence) || !["ACTIVE", "INVALIDATE_REVIEW", "SHIFT_ENDED"].includes(String(source.lifecycle))) throw new Error("INVALID_DRIVER_SHIFT");
  const policy = decodeEffectiveDriverPolicy(source.effectivePolicy);
  if (policy.assignmentId !== assignmentId || policy.driverId !== driverId || policy.organizationId !== driverOrganizationId) throw new Error("INVALID_DRIVER_SHIFT");
  return { ...source, effectivePolicy: policy } as unknown as DriverShiftState;
}

function decodePrecheck(value: unknown, shiftReference: string): DriverPrecheckReceipt {
  const source = object(value);
  if (source.shiftReference !== shiftReference || typeof source.vehicleId !== "string" || !uuid.test(source.vehicleId) || !Number.isSafeInteger(source.resourceVersion) ||
    !["READY", "BLOCKED_CRITICAL_DEFECT"].includes(String(source.vehicleState)) || !["COMPLETED", "SKIPPED", "NOT_REQUIRED"].includes(String(source.inspectionOutcome)) ||
    !["COMPLETED", "SKIPPED", "NOT_REQUIRED"].includes(String(source.odometerOutcome))) throw new Error("INVALID_DRIVER_PRECHECK");
  return source as unknown as DriverPrecheckReceipt;
}

function decodeClosure(value: unknown, shiftReference: string, driverId: string): DriverClosureView {
  const source = object(value); const tracking = object(source.tracking);
  if (source.shiftReference !== shiftReference || source.driverId !== driverId || typeof source.shiftGeneration !== "string" || !uuid.test(source.shiftGeneration) ||
    !Number.isSafeInteger(source.resourceVersion) || typeof source.collectionStopped !== "boolean" || typeof tracking.status !== "string" || typeof tracking.contactDriver !== "boolean") throw new Error("INVALID_DRIVER_CLOSURE");
  return source as unknown as DriverClosureView;
}

function decodeLoginState(value:unknown,expectedDriver?:string){
  const source=object(value);
  if(!['claimedAt,driverId,lastLoginAt,loginId,status,version','claimedAt,driverId,lastLoginAt,loginId,sessionToken,status,version'].includes(Object.keys(source).sort().join()))throw new Error('INVALID_DRIVER_LOGIN_STATE');
  if(typeof source.driverId!=='string'||!uuid.test(source.driverId)||(expectedDriver&&source.driverId!==expectedDriver))throw new Error('INVALID_DRIVER_LOGIN_STATE');
  if(!['INVITED','ACTIVE','LOCKED'].includes(String(source.status)))throw new Error('INVALID_DRIVER_LOGIN_STATE');
  if(typeof source.loginId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(source.loginId))throw new Error('INVALID_DRIVER_LOGIN_STATE');
  for(const field of ['claimedAt','lastLoginAt'])if(source[field]!==null&&(typeof source[field]!=='string'||!Number.isFinite(Date.parse(String(source[field])))))throw new Error('INVALID_DRIVER_LOGIN_STATE');
  if(!Number.isSafeInteger(source.version)||Number(source.version)<1)throw new Error('INVALID_DRIVER_LOGIN_STATE');
  if(source.sessionToken!==undefined&&(typeof source.sessionToken!=='string'||!/^dvs_[A-Za-z0-9_-]{43}$/.test(source.sessionToken)))throw new Error('INVALID_DRIVER_LOGIN_STATE');
  return {driverId:source.driverId,loginId:source.loginId,status:String(source.status),
    claimedAt:source.claimedAt as string|null,lastLoginAt:source.lastLoginAt as string|null,version:Number(source.version),
    ...(source.sessionToken?{sessionToken:source.sessionToken as string}:{})};
}

export function createCloudDriverWebApi(baseUrl: string, fetcher: DevelopmentFetch) {
  const browserSameOrigin = new URL(baseUrl).protocol === "https:";
  let activeDriverId:string|null=null,sessionToken:string|null=null;
  const bootstrap=createPrivateDevelopmentTransport({ baseUrl, persona: "driver", fetch: fetcher, browserSameOrigin, anonymous:true });
  const transport = createPrivateDevelopmentTransport({ baseUrl, persona: "driver", fetch: fetcher, browserSameOrigin,driverSession:()=>sessionToken });
  const authenticatedDriver=()=>{if(!activeDriverId)throw new Error('DRIVER_SESSION_REQUIRED');return activeDriverId;};
  const acceptLogin=(value:unknown,expectedDriver?:string)=>{
    const state=decodeLoginState(value,expectedDriver);
    if(state.status!=='ACTIVE'||!state.sessionToken)throw new Error('DRIVER_SESSION_REQUIRED');
    activeDriverId=state.driverId;sessionToken=state.sessionToken;
    return state;
  };
  const prefix = `/v1/organizations/${driverOrganizationId}/driver`;
// Driver logins are registered on the organization root (dispatch creates them there),
// not under the /driver prefix this client uses for shift and itinerary calls.
const loginPrefix = `/v1/organizations/${driverOrganizationId}`;
  return Object.freeze({
    async authenticate(signal?: AbortSignal) {
      return transport.request("/v1/me", value => {
        const body = object(value);
        if (body.principalKind !== "SYNTHETIC_DEVICE" || !Array.isArray(body.organizations)) throw new Error("INVALID_DRIVER_SESSION");
        const membership = body.organizations.map(object).find(item => item.organizationId === driverOrganizationId);
        if (!membership || !Array.isArray(membership.capabilities) || !membership.capabilities.includes("driver:manifest:read") || !membership.capabilities.includes("driver:execute")) throw new Error("INVALID_DRIVER_SESSION");
        return { driverId:authenticatedDriver(), organizationId: driverOrganizationId };
      }, undefined, signal);
    },
    /** The driver sets their own password once, on the phone that holds the invite
     * code. The server stores a scrypt digest and clears the code. */
    claimLogin(request:{driverId:string;inviteCode:string;password:string}, key:string) {
      if(!uuid.test(request.driverId)||request.inviteCode.length<8||request.password.length<8)throw new Error("INVALID_DRIVER_LOGIN_CLAIM");
      return bootstrap.request(`${loginPrefix}/driver-logins/${request.driverId}/commands/claim`,
        value=>acceptLogin(value,request.driverId),{body:{driverId:request.driverId,inviteCode:request.inviteCode,password:request.password},idempotencyKey:key});
    },
    /** Password sign-in. The server answers one rejection code for an unknown phone, an
     * unclaimed login, a wrong password and a locked login. */
    verifyLogin(request:{loginId:string;password:string}, key:string) {
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(request.loginId)||request.password.length<8)throw new Error("INVALID_DRIVER_LOGIN_VERIFY");
      return bootstrap.request(`${loginPrefix}/driver-logins/commands/verify`,value=>acceptLogin(value),{body:request,idempotencyKey:key});
    },
    itinerary(serviceDate: string, signal?: AbortSignal) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error("INVALID_SERVICE_DATE");
      return transport.request(`${prefix}/itineraries/${serviceDate}`,value=>decodeDriverItinerary(value,authenticatedDriver()), undefined, signal);
    },
    roadRoute(legId:string,signal?:AbortSignal){
      if(!uuid.test(legId))throw new Error('INVALID_LEG_REFERENCE');
      return transport.request(`${prefix}/legs/${legId}/road-route`,decodeDriverRoadRoute,undefined,signal);
    },
    startShift(leg: DriverItinerary["legs"][number], serviceDate: string, key: string, loginId?: string) {
      return transport.request(`${prefix}/shifts/commands/start`, value => {
        const body = object(value); const policy = decodeEffectiveDriverPolicy(body.effectivePolicy);
        if (policy.assignmentId !== leg.assignmentId || typeof body.shiftReference !== "string" || typeof body.shiftGeneration !== "string" || !Number.isSafeInteger(body.resourceVersion)) throw new Error("INVALID_SHIFT_RECEIPT");
        return { ...body, effectivePolicy: policy } as unknown as StartDriverShiftReceipt;
      }, { body: { assignmentId: leg.assignmentId, serviceDate, expectedAssignmentVersion: leg.assignmentVersion, ...(loginId ? { loginId } : {}) }, idempotencyKey: key });
    },
    shift(assignmentId: string, signal?: AbortSignal) {
      if (!uuid.test(assignmentId)) throw new Error("INVALID_ASSIGNMENT");
      return transport.request(`${prefix}/shifts/assignments/${assignmentId}`, value => decodeShift(value, assignmentId,authenticatedDriver()), undefined, signal);
    },
    precheck(shiftReference: string, request: DriverPrecheckRequest, key: string, stage: "pre" | "post") {
      if (!uuid.test(shiftReference)) throw new Error("INVALID_SHIFT");
      return transport.request(`${prefix}/shifts/${shiftReference}/commands/${stage === "pre" ? "precheck" : "postcheck"}`,
        value => decodePrecheck(value, shiftReference), { body: request, idempotencyKey: key });
    },
    action(batch: DriverActionBatch, key: string) {
      return transport.request(`${prefix}/action-batches`, value => {
        const body = object(value);
        if (typeof body.batchReference !== "string" || !Array.isArray(body.items) || body.items.length !== batch.items.length) throw new Error("INVALID_DRIVER_ACTION_RECEIPT");
        return body as unknown as BatchReceipt;
      }, { body: batch, idempotencyKey: key });
    },
    signature(shiftReference: string, legReference: string, request: DriverSignatureRequest, key: string) {
      if (![shiftReference, legReference].every(uuid.test.bind(uuid))) throw new Error("INVALID_SIGNATURE_BINDING");
      return transport.request(`${prefix}/shifts/${shiftReference}/legs/${legReference}/evidence/signatures`, value => {
        const body = object(value);
        if (body.shiftReference !== shiftReference || body.tripLegId !== legReference || body.evidenceId !== request.evidenceId || body.digest !== request.digest || body.status !== "ACCEPTED_FOR_SERVICE_CONTROL") throw new Error("INVALID_SIGNATURE_RECEIPT");
        return body as unknown as DriverSignatureReceipt;
      }, { body: request, idempotencyKey: key });
    },
    closure(shiftReference: string, signal?: AbortSignal) {
      if (!uuid.test(shiftReference)) throw new Error("INVALID_SHIFT");
      return transport.request(`${prefix}/shifts/${shiftReference}/status`, value => decodeClosure(value, shiftReference,authenticatedDriver()), undefined, signal);
    },
    /** Real device fixes for the live map. The transport keeps them out of logs and the
     * decoder accepts only the closed outcomes the server can answer with. */
    locationBatch(shiftReference: string, request: DriverLocationBatchRequest, key: string) {
      if (!uuid.test(shiftReference)) throw new Error("INVALID_SHIFT_REFERENCE");
      return transport.request(`${prefix}/shifts/${shiftReference}/location-batches`, value => {
        const body = object(value);
        if (body.shiftReference !== shiftReference || body.batchReference !== request.batchReference || !Array.isArray(body.items) || body.items.length !== request.samples.length)
          throw new Error("INVALID_LOCATION_BATCH_RECEIPT");
        for (const item of body.items) {
          const row = object(item);
          if (typeof row.sampleId !== "string" || !["APPLIED", "REPLAYED", "REJECTED"].includes(String(row.outcome)) ||
              !["LOCATION_SAMPLE_SAVED", "SAMPLE_OUTSIDE_RETENTION"].includes(String(row.code))) throw new Error("INVALID_LOCATION_BATCH_RECEIPT");
        }
        return body as unknown as DriverLocationBatchReceipt;
      }, { body: request, idempotencyKey: key });
    },
    close(shiftReference: string, request: DriverClosureRequest, key: string) {
      return transport.request(`${prefix}/shifts/${shiftReference}/commands/close`, value => {
        const body = object(value);
        if (body.shiftReference !== shiftReference || !Number.isSafeInteger(body.resourceVersion) || typeof body.collectionStopped !== "boolean" || !["ACTIVE", "SHIFT_ENDED"].includes(String(body.lifecycle))) throw new Error("INVALID_CLOSURE_RECEIPT");
        return body as unknown as DriverClosureReceipt;
      }, { body: request, idempotencyKey: key });
    },
  });
}

export type DriverLeg = DriverItinerary["legs"][number];
export type DriverCommand = DriverActionItem["command"];
