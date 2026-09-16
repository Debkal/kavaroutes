import { decodeEffectiveDriverPolicy, type DriverItinerary, type StartDriverShiftReceipt, type DriverPrecheckRequest, type DriverPrecheckReceipt, type DriverShiftState, type DriverActionBatch, type BatchReceipt } from "@kavaroutes/api-contracts/client-web";
import { createPrivateDevelopmentTransport, type DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";
import type { DriverPolicySnapshot } from "@kavaroutes/driver-core";
import type { DriverSignatureRequest, DriverSignatureReceipt } from "@kavaroutes/api-contracts/client-web";
import {decodeRouteView,decodeRouteReceipt,type RouteRequest} from '@kavaroutes/api-contracts/client-route-proposals';
import type {DriverClosureRequest,DriverClosureReceipt,DriverClosureView,DriverSyntheticLocationRequest,DriverSyntheticLocationReceipt} from '@kavaroutes/api-contracts/client-web';

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import { driverRuntime } from './runtime-config';
export const privateCloudDriver = driverRuntime.privateCloud;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_API_RESPONSE");
  return value as Record<string, unknown>;
}
export function decodeCloudItinerary(value: unknown): DriverItinerary {
  const source = object(value);
  if (Object.keys(source).sort().join(",") !== "driverReference,legs,serviceDate") throw new Error("INVALID_DRIVER_ITINERARY");
  if (source.driverReference !== "30000000-0000-4000-8000-000000000001" || typeof source.serviceDate !== "string" || !Array.isArray(source.legs) || source.legs.length > 500) throw new Error("INVALID_DRIVER_ITINERARY");
  for (const raw of source.legs) {
    const leg = object(raw);
    if (Object.keys(leg).filter(key => key !== "execution").sort().join(",") !== "assignmentId,assignmentVersion,dropoffLabel,ordinal,pickupLabel,plannedEndAt,plannedStartAt,riderLabel,runId,runLifecycle,runVersion,serviceTimezone,tripId,tripLegId,vehicleId,vehicleLabel" ||
      typeof leg.assignmentId !== "string" || !Number.isInteger(leg.assignmentVersion) || Number(leg.assignmentVersion) < 1 || typeof leg.runId !== "string" ||
      !Number.isInteger(leg.runVersion) || typeof leg.runLifecycle !== "string" || !(leg.vehicleId === null || typeof leg.vehicleId === "string") ||
      !(leg.vehicleLabel === null || typeof leg.vehicleLabel === "string") || typeof leg.tripId !== "string" ||
      !Number.isInteger(leg.ordinal) || Number(leg.ordinal) < 1 || typeof leg.tripLegId !== "string" ||
      typeof leg.riderLabel !== "string" || typeof leg.pickupLabel !== "string" || typeof leg.dropoffLabel !== "string" ||
      typeof leg.plannedStartAt !== "string" || !Number.isFinite(Date.parse(leg.plannedStartAt)) ||
      typeof leg.plannedEndAt !== "string" || !Number.isFinite(Date.parse(leg.plannedEndAt)) || typeof leg.serviceTimezone !== "string") throw new Error("INVALID_DRIVER_ITINERARY");
    if (leg.execution !== undefined && leg.execution !== null) {
      const execution = object(leg.execution);
      if (Object.keys(execution).filter(key => !["expectedTag","serviceControl"].includes(key)).sort().join(",") !== "executionId,lifecycle,version" || typeof execution.executionId !== "string" || !uuid.test(execution.executionId) ||
        typeof execution.lifecycle !== "string" || !/^[A-Z][A-Z_]{1,63}$/.test(execution.lifecycle) || !Number.isSafeInteger(execution.version) || Number(execution.version) < 1) throw new Error("INVALID_DRIVER_ITINERARY");
      if (execution.expectedTag !== undefined && (typeof execution.expectedTag !== "string" || !/^"kr1\.[A-Za-z0-9_-]{43}"$/.test(execution.expectedTag))) throw new Error("INVALID_DRIVER_ITINERARY");
      if(execution.serviceControl!==undefined) {
        const c=object(execution.serviceControl);
        if(Object.keys(c).sort().join()!=="boardingSecure,dropoffEvidenceId,incidentOpen,pickupEvidenceId,proofRule,riderVerified,safelyUnloaded" ||
          [c.riderVerified,c.boardingSecure,c.safelyUnloaded,c.incidentOpen].some(v=>typeof v!=="boolean") ||
          [c.pickupEvidenceId,c.dropoffEvidenceId].some(v=>v!==null && (typeof v!=="string" || !uuid.test(v)))) throw new Error("INVALID_DRIVER_ITINERARY");
        if(c.proofRule!==null) {
          const p=object(c.proofRule),r=object(p.rule);
          if(Object.keys(p).sort().join()!=="digest,rule,version" || !Number.isSafeInteger(p.version) || Number(p.version)<1 || typeof p.digest!=="string" || !/^[a-f0-9]{64}$/.test(p.digest) ||
            Object.keys(r).sort().join()!=="allowedRoles,dropoffRequired,mobilitySecurementRequired,noShowAllowed,noShowAuthorizationReference,noShowWaitMinutes,pickupRequired,unableReasons" ||
            [r.pickupRequired,r.dropoffRequired,r.mobilitySecurementRequired,r.noShowAllowed].some(v=>typeof v!=="boolean") ||
            !Array.isArray(r.allowedRoles) || !r.allowedRoles.length || r.allowedRoles.some(v=>!["RIDER","GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE","FACILITY_EMPLOYEE","DRIVER","RIDER_UNABLE_TO_SIGN"].includes(v)) ||
            !Array.isArray(r.unableReasons) || r.unableReasons.some(v=>!["DECLINED","PHYSICALLY_UNABLE","NO_AUTHORIZED_SIGNER"].includes(v)) ||
            !Number.isSafeInteger(r.noShowWaitMinutes) || Number(r.noShowWaitMinutes)<1 || Number(r.noShowWaitMinutes)>120 ||
            r.noShowAuthorizationReference!==null && (typeof r.noShowAuthorizationReference!=="string" || !uuid.test(r.noShowAuthorizationReference))) throw new Error("INVALID_DRIVER_ITINERARY");
        }
      }
    }
  }
  return source as unknown as DriverItinerary;
}
function shiftReceipt(value: unknown, assignmentId: string): StartDriverShiftReceipt {
  const source = object(value); const policy = object(source.effectivePolicy);
  if (Object.keys(source).sort().join(",") !== "effectivePolicy,outcome,resourceVersion,shiftGeneration,shiftReference" ||
    !["APPLIED", "REPLAYED"].includes(String(source.outcome)) || typeof source.shiftReference !== "string" || !uuid.test(source.shiftReference) ||
    typeof source.shiftGeneration !== "string" || !uuid.test(source.shiftGeneration) || !Number.isInteger(source.resourceVersion) || Number(source.resourceVersion) < 1 ||
    policy.driverId !== "30000000-0000-4000-8000-000000000001" || policy.assignmentId !== assignmentId) throw new Error("INVALID_SHIFT_RECEIPT");
  decodeEffectiveDriverPolicy(source.effectivePolicy);
  return source as unknown as StartDriverShiftReceipt;
}
export function decodeCloudPrecheckReceipt(value: unknown, shiftId: string, vehicleId?: string): DriverPrecheckReceipt {
  const source = object(value);
  if (Object.keys(source).sort().join(",") !== "fuelLevel,inspectionOutcome,odometer,odometerOutcome,resourceVersion,shiftReference,vehicleId,vehicleState" ||
    source.shiftReference !== shiftId || typeof source.vehicleId !== "string" || !uuid.test(source.vehicleId) || (vehicleId && source.vehicleId !== vehicleId) ||
    !Number.isSafeInteger(source.resourceVersion) || Number(source.resourceVersion) < 2 || !["READY", "BLOCKED_CRITICAL_DEFECT"].includes(String(source.vehicleState)) ||
    !["COMPLETED", "SKIPPED", "NOT_REQUIRED"].includes(String(source.inspectionOutcome)) || !["COMPLETED", "SKIPPED", "NOT_REQUIRED"].includes(String(source.odometerOutcome))) throw new Error("INVALID_PRECHECK_RECEIPT");
  if (source.odometerOutcome === "COMPLETED" ? !Number.isSafeInteger(source.odometer) || Number(source.odometer) < 0 || Number(source.odometer) > 9999999 ||
    !["EMPTY", "QUARTER", "HALF", "THREE_QUARTERS", "FULL"].includes(String(source.fuelLevel)) : source.odometer !== null || source.fuelLevel !== null) throw new Error("INVALID_PRECHECK_RECEIPT");
  return source as unknown as DriverPrecheckReceipt;
}
function serviceDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("SERVICE_DATE_UNAVAILABLE");
  return date;
}
export function createCloudDriverApi(options?: { readonly baseUrl: string; readonly fetch: DevelopmentFetch }) {
  if (!options && !privateCloudDriver) throw new Error("PRIVATE_CLOUD_DRIVER_NOT_ENABLED");
  const baseUrl = options?.baseUrl ?? driverRuntime.apiUrl;
  if (!baseUrl) throw new Error("PRIVATE_DEVELOPMENT_API_URL_REQUIRED");
  const remote = createPrivateDevelopmentTransport({ baseUrl, persona: "driver",
    fetch: options?.fetch ?? globalThis.fetch as unknown as DevelopmentFetch });
  return Object.freeze({
    getClosure(shift:string){if(!uuid.test(shift))throw new Error('INVALID_SHIFT');return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shift}/status`,value=>{
      const r=object(value),t=object(r.tracking);
      if(Object.keys(r).sort().join()!=='collectionStopped,driverId,lastEvent,lifecycle,postcheck,resourceVersion,returnMode,returnResult,sample,shiftGeneration,shiftReference,tracking'||r.shiftReference!==shift||r.driverId!=='30000000-0000-4000-8000-000000000001'||typeof r.shiftGeneration!=='string'||!uuid.test(r.shiftGeneration)||!Number.isSafeInteger(r.resourceVersion)||typeof r.collectionStopped!=='boolean'||!['ACTIVE','SHIFT_ENDED','INVALIDATE_REVIEW'].includes(String(r.lifecycle))||!['DISABLED','ADVISORY','REQUIRED_WITH_AUDITED_OVERRIDE'].includes(String(r.returnMode))||typeof t.status!=='string'||typeof t.contactDriver!=='boolean')throw new Error('INVALID_CLOSURE_STATE');
      if(r.postcheck!==null){const p=object(r.postcheck);if(Object.keys(p).sort().join()!=='fuelLevel,inspectionOutcome,odometer,odometerOutcome,resourceVersion,vehicleState'||![p.inspectionOutcome,p.odometerOutcome].every(v=>['NOT_REQUIRED','SKIPPED','COMPLETED'].includes(String(v)))||!['READY','BLOCKED_CRITICAL_DEFECT'].includes(String(p.vehicleState))||!Number.isSafeInteger(p.resourceVersion)||(p.odometer!==null&&(!Number.isSafeInteger(p.odometer)||Number(p.odometer)<0)))throw new Error('INVALID_POSTCHECK_STATE');}
      if(r.sample!==null){const s=object(r.sample);if(typeof s.sampleId!=='string'||!uuid.test(s.sampleId)||!Number.isSafeInteger(s.sequence)||typeof s.fresh!=='boolean')throw new Error('INVALID_SAMPLE_STATE');}
      return r as unknown as DriverClosureView;
    });},
    submitClosure(shift:string,request:DriverClosureRequest,key:string){if(!uuid.test(shift))throw new Error('INVALID_SHIFT');return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shift}/commands/close`,value=>{
      const r=object(value);if(Object.keys(r).sort().join()!=='collectionStopped,lifecycle,outcome,resourceVersion,returnResult,shiftReference'||r.shiftReference!==shift||!Number.isSafeInteger(r.resourceVersion)||Number(r.resourceVersion)<1||!['ACTIVE','SHIFT_ENDED'].includes(String(r.lifecycle))||typeof r.collectionStopped!=='boolean'||!['EMERGENCY_STOP_RECORDED','SHIFT_ENDED','RETURN_REVIEW_REQUIRED'].includes(String(r.outcome))||!['NOT_REQUIRED','PASS','OUTSIDE','STALE','INACCURATE','UNAVAILABLE','OVERRIDDEN'].includes(String(r.returnResult))||r.lifecycle==='SHIFT_ENDED'&&(!r.collectionStopped||r.outcome!=='SHIFT_ENDED'))throw new Error('INVALID_CLOSURE_RECEIPT');return r as unknown as DriverClosureReceipt;
    },{body:request,idempotencyKey:key});},
    submitSyntheticLocations(shift:string,request:DriverSyntheticLocationRequest,key:string){if(!uuid.test(shift))throw new Error('INVALID_SHIFT');return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shift}/synthetic-location-batches`,value=>{
      const r=object(value);if(Object.keys(r).join()!=='items'||!Array.isArray(r.items)||r.items.length!==request.samples.length)throw new Error('INVALID_LOCATION_RECEIPT');
      r.items.forEach((raw,i)=>{const v=object(raw);if(Object.keys(v).sort().join()!=='code,outcome,sampleId'||v.sampleId!==request.samples[i]?.sampleId||!['APPLIED','REPLAYED','REJECTED'].includes(String(v.outcome))||!['SYNTHETIC_SAMPLE_SAVED','SAMPLE_OUTSIDE_RETENTION'].includes(String(v.code)))throw new Error('INVALID_LOCATION_RECEIPT');});return r as unknown as DriverSyntheticLocationReceipt;
    },{body:request,idempotencyKey:key});},
    getRouteProposals(shiftId:string){if(!uuid.test(shiftId))throw new Error('INVALID_SHIFT');return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shiftId}/route-proposals`,v=>decodeRouteView(v,shiftId));},
    submitRouteProposal(shiftId:string,request:RouteRequest,key:string){if(!uuid.test(shiftId))throw new Error('INVALID_SHIFT');const {expectedTag,...body}=request;return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shiftId}/route-proposals`,v=>decodeRouteReceipt(v,request.proposalId),{body,etag:expectedTag,idempotencyKey:key});},
    async authenticate(signal?: AbortSignal) {
      return remote.request("/v1/me", value => {
        const body = object(value);
        if (body.principalKind !== "SYNTHETIC_DEVICE" || !Array.isArray(body.organizations)) throw new Error("INVALID_DRIVER_SESSION");
        const membership = body.organizations.map(object).find(item => item.organizationId === organizationId);
        if (!membership || !Array.isArray(membership.capabilities) || !membership.capabilities.includes("driver:manifest:read") || !membership.capabilities.includes("driver:execute")) throw new Error("INVALID_DRIVER_SESSION");
        return "authenticated" as const;
      }, undefined, signal);
    },
    currentServiceDate: serviceDate,
    async getItinerary(date = serviceDate(), signal?: AbortSignal) {
      return remote.request(`/v1/organizations/${organizationId}/driver/itineraries/${date}`, decodeCloudItinerary, undefined, signal);
    },
    async startShift(input: { assignmentId: string; assignmentVersion: number; serviceDate: string; idempotencyKey: string }) {
      return remote.request(`/v1/organizations/${organizationId}/driver/shifts/commands/start`, value => shiftReceipt(value, input.assignmentId), {
          body: { assignmentId: input.assignmentId, serviceDate: input.serviceDate, expectedAssignmentVersion: input.assignmentVersion },
          idempotencyKey: input.idempotencyKey,
      });
    },
    async getShift(assignmentId: string) {
      return remote.request(`/v1/organizations/${organizationId}/driver/shifts/assignments/${assignmentId}`, value => {
        const source = object(value);
        if (Object.keys(source).sort().join(",") !== "effectivePolicy,lastActionSequence,lifecycle,precheck,resourceVersion,shiftGeneration,shiftReference" ||
          typeof source.shiftReference !== "string" || !uuid.test(source.shiftReference) || typeof source.shiftGeneration !== "string" || !uuid.test(source.shiftGeneration) ||
          !Number.isSafeInteger(source.resourceVersion) || Number(source.resourceVersion) < 1 ||
          !Number.isSafeInteger(source.lastActionSequence) || Number(source.lastActionSequence) < 0 ||
          !["ACTIVE", "INVALIDATE_REVIEW", "SHIFT_ENDED"].includes(String(source.lifecycle))) throw new Error("INVALID_SHIFT_STATE");
        const policy = decodeEffectiveDriverPolicy(source.effectivePolicy);
        if (policy.organizationId !== organizationId || policy.driverId !== "30000000-0000-4000-8000-000000000001" || policy.assignmentId !== assignmentId) throw new Error("INVALID_SHIFT_STATE");
        if (source.precheck !== null) decodeCloudPrecheckReceipt(source.precheck, source.shiftReference);
        return source as unknown as DriverShiftState;
      });
    },
    async submitPrecheck(shiftId: string, request: DriverPrecheckRequest, key: string) {
      return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shiftId}/commands/precheck`,
        value => decodeCloudPrecheckReceipt(value, shiftId, request.vehicleId), { body: request, idempotencyKey: key });
    },
    async submitPostcheck(shiftId:string,request:DriverPrecheckRequest,key:string){return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shiftId}/commands/postcheck`,value=>decodeCloudPrecheckReceipt(value,shiftId,request.vehicleId),{body:request,idempotencyKey:key});},
    async submitSignature(shift: string,leg: string,request: DriverSignatureRequest,key: string) {
      return remote.request(`/v1/organizations/${organizationId}/driver/shifts/${shift}/legs/${leg}/evidence/signatures`,value=>{
        const r=object(value);
        if(Object.keys(r).sort().join()!=="digest,event,evidenceId,resourceVersion,shiftReference,status,tripLegId" ||
          r.evidenceId!==request.evidenceId || r.shiftReference!==shift || r.tripLegId!==leg || r.event!==request.event || r.digest!==request.digest ||
          r.status!=="ACCEPTED_FOR_SERVICE_CONTROL" || !Number.isSafeInteger(r.resourceVersion) || Number(r.resourceVersion)<1) throw new Error("INVALID_SIGNATURE_RECEIPT");
        return r as unknown as DriverSignatureReceipt;
      },{body:request,idempotencyKey:key});
    },
    async submitActions(request: DriverActionBatch, key: string) {
      return remote.request(`/v1/organizations/${organizationId}/driver/action-batches`, value => {
        const body = object(value);
        if (Object.keys(body).sort().join() !== "batchReference,items" || typeof body.batchReference !== "string" || !uuid.test(body.batchReference) ||
          !Array.isArray(body.items) || body.items.length !== request.items.length) throw new Error("INVALID_ACTION_RECEIPT");
        body.items.forEach((raw, index) => {
          const item = object(raw);
          if (item.clientItemId !== request.items[index]?.clientActionId || !["APPLIED","REPLAYED","REJECTED"].includes(String(item.outcome)) ||
            (item.outcome === "REJECTED" ? Object.keys(item).sort().join() !== "clientItemId,code,outcome" || typeof item.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(item.code) :
              Object.keys(item).sort().join() !== "clientItemId,outcome,resourceVersion" || !Number.isSafeInteger(item.resourceVersion) || Number(item.resourceVersion) < 1)) throw new Error("INVALID_ACTION_RECEIPT");
        });
        return body as unknown as BatchReceipt;
      }, { body: request, idempotencyKey: key });
    },
  });
}
export function toDriverPolicy(value: StartDriverShiftReceipt["effectivePolicy"]): DriverPolicySnapshot {
  return value as unknown as DriverPolicySnapshot;
}
