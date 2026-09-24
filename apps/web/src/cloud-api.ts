import { decodeDispatcherTrip, type DispatcherTrip, type TripCreateRequest } from "@kavaroutes/api-contracts/client-web";
import {createCloudCommandRecovery} from './cloud-command-recovery';
import {decodeCloudBoard,decodeCloudAssignment,decodeCloudPlanReceipt,decodeCloudDriverAccount,decodeCloudDriverLogin,decodeCloudRelease,type CloudAssignmentCommand,type CloudPlanRequest} from './cloud-board-contract';
import {decodeRouteView,decodeRouteReceipt} from '@kavaroutes/api-contracts/client-route-proposals';
import { createPrivateDevelopmentTransport, type DevelopmentFetch } from "@kavaroutes/api-contracts/private-development-transport";
import {decodeRoadSelection,decodeRoadPreview,type RoadGoal} from './road-route-contract';

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = `/v1/organizations/${organizationId}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function tripPath(id: string) { if (!uuid.test(id)) throw new Error("INVALID_TRIP_REFERENCE"); return `${prefix}/trips/${id}`; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_API_RESPONSE");
  return value as Record<string, unknown>;
}

export function createCloudApi(baseUrl: string, fetcher: DevelopmentFetch) {
  const browserSameOrigin = new URL(baseUrl).protocol === "https:";
  const transport = createPrivateDevelopmentTransport({ baseUrl, persona: "dispatcher", fetch: fetcher, browserSameOrigin });
  // Explicitly selected synthetic reviewer, never a privilege added to the dispatcher.
  const reviewer=createPrivateDevelopmentTransport({baseUrl,persona:'policy_override',fetch:fetcher,browserSameOrigin});
  const recovery=createCloudCommandRecovery(transport),reviewerRecovery=createCloudCommandRecovery(reviewer);
  return Object.freeze({
    recovery,reviewerRecovery,
    returnReview(shift:string){
      if(!uuid.test(shift))throw new Error('INVALID_SHIFT');
      return reviewer.request(`${prefix}/dispatch/shifts/${shift}/return-review`,body=>{
        const v=object(body);
        const reviewKeys=Object.keys(v).sort().join();if(reviewKeys!=='closurePath,exceptionCommandId,lifecycle,resourceVersion,returnMode,returnResult,shiftGeneration,shiftReference'&&reviewKeys!=='exceptionCommandId,lifecycle,resourceVersion,returnMode,returnResult,shiftGeneration,shiftReference'||v.shiftReference!==shift||typeof v.shiftGeneration!=='string'||!uuid.test(v.shiftGeneration)||!Number.isSafeInteger(v.resourceVersion)||Number(v.resourceVersion)<1||(v.exceptionCommandId!==null&&(typeof v.exceptionCommandId!=='string'||!uuid.test(v.exceptionCommandId)))||!['ACTIVE','SHIFT_ENDED','INVALIDATE_REVIEW'].includes(String(v.lifecycle))||!['DISABLED','ADVISORY','REQUIRED_WITH_AUDITED_OVERRIDE'].includes(String(v.returnMode))||(v.returnResult!==null&&!['NOT_REQUIRED','PASS','OUTSIDE','STALE','INACCURATE','UNAVAILABLE','OVERRIDDEN'].includes(String(v.returnResult)))||(v.closurePath!==null&&!['RETURN_EXCEPTION','EMERGENCY_STOP'].includes(String(v.closurePath))))throw new Error('INVALID_RETURN_REVIEW');
        return {shiftReference:shift,shiftGeneration:v.shiftGeneration,resourceVersion:Number(v.resourceVersion),exceptionCommandId:v.exceptionCommandId as string|null,lifecycle:String(v.lifecycle),returnMode:String(v.returnMode),returnResult:v.returnResult as string|null,closurePath:(v.closurePath??null) as 'RETURN_EXCEPTION'|'EMERGENCY_STOP'|null};
      });
    },
    overrideReturn(shift:string,command:{commandId:string;shiftGeneration:string;expectedVersion:number;exceptionCommandId:string;reason:'RETURN_EXCEPTION_REVIEWED';emergencyStopResolution?:boolean;key:string}){
      if([shift,command.commandId,command.shiftGeneration,command.exceptionCommandId].some(id=>!uuid.test(id)))throw new Error('INVALID_OVERRIDE_REFERENCE');
      const {key,...body}=command;
      return reviewerRecovery.run({kind:'OVERRIDE_RETURN',resourceId:shift,body},key,value=>{
        const r=object(value);if(Object.keys(r).sort().join()!=='collectionStopped,lifecycle,outcome,resourceVersion,returnResult,shiftReference'||r.shiftReference!==shift||r.lifecycle!=='SHIFT_ENDED'||r.collectionStopped!==true||r.outcome!=='SHIFT_ENDED'||r.returnResult!=='OVERRIDDEN'||!Number.isSafeInteger(r.resourceVersion)||Number(r.resourceVersion)<2)throw new Error('INVALID_OVERRIDE_RECEIPT');return {shiftReference:shift,resourceVersion:Number(r.resourceVersion)};
      });
    },
    shiftStatus(shiftId:string){
      if(!uuid.test(shiftId))throw new Error('INVALID_SHIFT');
      return transport.request(`${prefix}/dispatch/shifts/${shiftId}/status`,body=>{
        const v=object(body),t=object(v.tracking);
        if(v.shiftReference!==shiftId||!['ACTIVE','SHIFT_ENDED','INVALIDATE_REVIEW'].includes(String(v.lifecycle))||Object.keys(t).sort().join()!=='contactDriver,evaluatedAt,lastCapturedAt,lastReceivedAt,reason,staleAfterSeconds,status'||
          !['SHIFT_ENDED','STATUS_UNAVAILABLE','TRACKING_STOPPED','NO_UPDATES','WAITING_FOR_FIRST_UPDATE','UPDATES_OVERDUE','UPDATES_CURRENT'].includes(String(t.status))||typeof t.contactDriver!=='boolean'||typeof t.reason!=='string'||!/^[A-Z_]{1,80}$/.test(t.reason)||t.staleAfterSeconds!==60||typeof t.evaluatedAt!=='string'||!Number.isFinite(Date.parse(t.evaluatedAt))||[t.lastCapturedAt,t.lastReceivedAt].some(v=>v!==null&&(typeof v!=='string'||!Number.isFinite(Date.parse(v)))))throw new Error('INVALID_TRACKING_STATUS');
        return {tracking:{status:String(t.status),reason:t.reason,contactDriver:t.contactDriver,evaluatedAt:t.evaluatedAt,lastCapturedAt:t.lastCapturedAt as string|null,lastReceivedAt:t.lastReceivedAt as string|null,staleAfterSeconds:60}};
      });
    },
    /** Live driver positioning for the service day: current position, bounded trace and
     * the silence a lost signal has produced. Coordinates are read here and rendered on
     * the map; they are never written into a message or a URL. */
    tracking(serviceDate:string){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))throw new Error('INVALID_SERVICE_DATE');
      return transport.request(`${prefix}/dispatch/tracking/${serviceDate}`,body=>{
        const v=object(body);
        if(Object.keys(v).sort().join(',')!=='serviceDate,shifts'||v.serviceDate!==serviceDate||!Array.isArray(v.shifts))throw new Error('INVALID_DISPATCH_TRACKING');
        const point=(raw:unknown)=>{const p=object(raw);
          if(Object.keys(p).sort().join(',')!=='accuracyMeters,capturedAt,latitude,longitude')throw new Error('INVALID_DISPATCH_TRACKING');
          if(typeof p.latitude!=='number'||p.latitude<-90||p.latitude>90||typeof p.longitude!=='number'||p.longitude<-180||p.longitude>180)throw new Error('INVALID_DISPATCH_TRACKING');
          if(p.accuracyMeters!==null&&(typeof p.accuracyMeters!=='number'||p.accuracyMeters<0))throw new Error('INVALID_DISPATCH_TRACKING');
          if(typeof p.capturedAt!=='string'||!Number.isFinite(Date.parse(p.capturedAt)))throw new Error('INVALID_DISPATCH_TRACKING');
          return {latitude:p.latitude,longitude:p.longitude,accuracyMeters:p.accuracyMeters as number|null,capturedAt:p.capturedAt};};
        const shifts=v.shifts.map(raw=>{const row=object(raw);
          if(typeof row.shiftReference!=='string'||!uuid.test(row.shiftReference)||typeof row.driverId!=='string'||!uuid.test(row.driverId)||typeof row.driverLabel!=='string')throw new Error('INVALID_DISPATCH_TRACKING');
          if(typeof row.silentSeconds!=='number'||row.silentSeconds<0||typeof row.contactDriver!=='boolean'||typeof row.status!=='string'||typeof row.reason!=='string')throw new Error('INVALID_DISPATCH_TRACKING');
          if(typeof row.retryAfterSeconds!=='number'||row.retryAfterSeconds<1||typeof row.staleAfterSeconds!=='number'||row.staleAfterSeconds<1)throw new Error('INVALID_DISPATCH_TRACKING');
          if(!Array.isArray(row.trace)||row.trace.length>500)throw new Error('INVALID_DISPATCH_TRACKING');
          if(row.position!==null&&row.position!==undefined&&typeof row.position!=='object')throw new Error('INVALID_DISPATCH_TRACKING');
          if(typeof row.plannedStartAt!=='string'||!Number.isFinite(Date.parse(row.plannedStartAt))||typeof row.startedAt!=='string'||!Number.isFinite(Date.parse(row.startedAt)))throw new Error('INVALID_DISPATCH_TRACKING');
          if(row.vehicleLabel!==null&&row.vehicleLabel!==undefined&&typeof row.vehicleLabel!=='string')throw new Error('INVALID_DISPATCH_TRACKING');
          return {shiftReference:row.shiftReference,driverId:row.driverId,driverLabel:row.driverLabel,plannedStartAt:row.plannedStartAt,
            startedAt:row.startedAt,vehicleLabel:(row.vehicleLabel??null) as string|null,
            lifecycle:String(row.lifecycle),status:String(row.status),
            reason:String(row.reason),contactDriver:row.contactDriver,silentSeconds:Math.round(row.silentSeconds),lastReceivedAt:(row.lastReceivedAt??null) as string|null,
            lastCapturedAt:(row.lastCapturedAt??null) as string|null,staleAfterSeconds:row.staleAfterSeconds,retryAfterSeconds:row.retryAfterSeconds,
            position:row.position?point(row.position):null,trace:row.trace.map(point)};});
        return {serviceDate,shifts};
      });
    },
    routeProposals(shiftId:string){if(!uuid.test(shiftId))throw new Error('INVALID_SHIFT');return transport.request(`${prefix}/dispatch/shifts/${shiftId}/route-proposals`,body=>decodeRouteView(body,shiftId));},
    decideRoute(command:{proposalId:string;decision:'APPROVED'|'REJECTED';expectedRunVersion:number;expectedTag:string;key:string}){
      if(!uuid.test(command.proposalId))throw new Error('INVALID_PROPOSAL');
      return recovery.run({kind:'DECIDE_ROUTE',resourceId:command.proposalId,expectedTag:command.expectedTag,body:{decision:command.decision,expectedRunVersion:command.expectedRunVersion}},command.key,body=>decodeRouteReceipt(body,command.proposalId));
    },
    board(serviceDate:string,signal?:AbortSignal){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))throw new Error('INVALID_SERVICE_DATE');
      return transport.request(`${prefix}/dispatch-board/${serviceDate}`,body=>decodeCloudBoard(body,serviceDate),undefined,signal);
    },
    roadRouteSelection(legId:string){
      if(!uuid.test(legId))throw new Error('INVALID_LEG_REFERENCE');
      return transport.request(`${prefix}/dispatch/legs/${legId}/road-route`,decodeRoadSelection);
    },
    previewRoadRoute(legId:string,goal:RoadGoal){
      if(!uuid.test(legId))throw new Error('INVALID_LEG_REFERENCE');
      return transport.request(`${prefix}/dispatch/legs/${legId}/road-route/preview`,body=>decodeRoadPreview(body,goal),
        {body:{goal},idempotencyKey:`road-preview-${crypto.randomUUID()}`});
    },
    selectRoadRoute(legId:string,goal:RoadGoal,expectedVersion:number,key:string){
      if(!uuid.test(legId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new Error('INVALID_ROAD_SELECTION');
      return transport.request(`${prefix}/dispatch/legs/${legId}/road-route/commands/select`,body=>{
        const selection=decodeRoadSelection(body);
        if(selection.goal!==goal||selection.version!==expectedVersion+1)throw new Error('ROAD_SELECTION_RECEIPT_MISMATCH');
        return selection;
      },{body:{goal,expectedVersion},idempotencyKey:key});
    },
    assign(command:CloudAssignmentCommand){
      if(!uuid.test(command.runId)||!uuid.test(command.driverId)||!uuid.test(command.vehicleId))throw new Error('INVALID_ASSIGNMENT_REFERENCE');
      return recovery.run({kind:'ASSIGN_RUN',resourceId:command.runId,expectedTag:command.expectedTag,body:{expectedVersion:command.expectedVersion,driverId:command.driverId,vehicleId:command.vehicleId}},command.key,body=>decodeCloudAssignment(body,command));
    },
    /** Remove the driver and vehicle from a run. The server releases the assignment
     * rather than superseding it, and refuses when work has started or the driver holds
     * an open shift. The key is per-tab memory, so a retry replays the same command. */
    unassignRun(runId:string,expectedVersion:number,ifMatch:string,idempotencyKey:string){
      if(!uuid.test(runId)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new Error('INVALID_RELEASE_REFERENCE');
      return transport.request(`${prefix}/dispatch/runs/${runId}/commands/unassign`,body=>decodeCloudRelease(body,{runId,expectedVersion,serviceDate:String((body as {serviceDate?:unknown}).serviceDate)}),{body:{expectedVersion},idempotencyKey,etag:ifMatch});
    },
    /** A dispatch-authored run. Nothing is inferred from fixtures: the server
     * persists the run, its legs, its addresses and its proof rules before the
     * board shows it. The idempotency key is per-tab memory, so retrying an
     * unknown outcome replays the original command instead of planning twice. */
    planRun(request:CloudPlanRequest,idempotencyKey:string){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(request.serviceDate))throw new Error('INVALID_SERVICE_DATE');
      if(!request.legs.length || request.legs.length>25)throw new Error('INVALID_PLAN_LEGS');
      return transport.request(`${prefix}/dispatch/runs/commands/plan`,body=>decodeCloudPlanReceipt(body,request),{body:request,idempotencyKey});
    },
    /** Dispatch issues a driver login. The one-time code is returned once, here, and
     * only its hash is stored; it has to be handed to the driver over a separate
     * channel. */
    createDriverLogin(request:{driverId:string;loginId:string},idempotencyKey:string){
      if(!uuid.test(request.driverId))throw new Error('INVALID_DRIVER_REFERENCE');
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(request.loginId))throw new Error('INVALID_DRIVER_LOGIN_ID');
      return transport.request(`${prefix}/driver-logins/commands/create`,body=>decodeCloudDriverLogin(body),{body:request,idempotencyKey});
    },
    createDriverAccount(request:{displayName:string;loginId:string;workforceRelationship:'OWNER_OPERATOR'|'EMPLOYEE'|'CONTRACTOR'},idempotencyKey:string){
      if(!request.displayName.trim()||request.displayName.trim().length>120)throw new Error('INVALID_DRIVER_NAME');
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(request.loginId))throw new Error('INVALID_DRIVER_LOGIN_ID');
      if(!['OWNER_OPERATOR','EMPLOYEE','CONTRACTOR'].includes(request.workforceRelationship))throw new Error('INVALID_WORKFORCE_RELATIONSHIP');
      return transport.request(`${prefix}/fleet/drivers/commands/create`,body=>decodeCloudDriverAccount(body),{body:{...request,displayName:request.displayName.trim()},idempotencyKey});
    },
    dispatchSnapshot(serviceDate: string, signal?: AbortSignal) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error("INVALID_SERVICE_DATE");
      return transport.request(`${prefix}/runtime-dispatch-snapshot?serviceDate=${serviceDate}`, body => {
        const snapshot = object(body);
        const projection = object(snapshot.projection);
        if (Object.keys(snapshot).sort().join(",") !== "cursor,etag,projection" || typeof snapshot.cursor !== "string" ||
          !/^rtc1\.[A-Za-z0-9_-]{48,8192}$/.test(snapshot.cursor) || typeof snapshot.etag !== "string") throw new Error("INVALID_DISPATCH_SNAPSHOT");
        const resources = Object.values(projection).map(raw => {
          const value = object(raw);
          if (Object.keys(value).sort().join(",") !== "kind,resourceKind,resourceReference,resourceVersion" ||
            value.kind !== "RESOURCE_INVALIDATED" || !["trip", "driver-shift", "run", "operation"].includes(String(value.resourceKind)) ||
            typeof value.resourceReference !== "string" || !value.resourceReference.startsWith(`${String(value.resourceKind)}:`) ||
            !uuid.test(value.resourceReference.slice(String(value.resourceKind).length + 1)) ||
            !Number.isSafeInteger(value.resourceVersion) || Number(value.resourceVersion) < 1) throw new Error("INVALID_DISPATCH_RESOURCE");
          return { kind: value.resourceKind as "trip" | "driver-shift" | "run" | "operation", reference: value.resourceReference, version: Number(value.resourceVersion) };
        });
        return { cursor: snapshot.cursor, resources };
      }, undefined, signal);
    },
    async authenticate(signal?: AbortSignal) {
      return transport.request("/v1/me", (body) => {
        const value = object(body);
        if (value.principalKind !== "SYNTHETIC_USER" || !Array.isArray(value.organizations)) throw new Error("INVALID_SESSION");
        const membership = value.organizations.map(object).find((item) => item.organizationId === organizationId);
        if (!membership || !Array.isArray(membership.capabilities) || !membership.capabilities.includes("trips:read")) throw new Error("INVALID_SESSION");
        return { principalId: String(value.principalId), organizationId };
      }, undefined, signal);
    },
    async list(cursor: string | null = null, signal?: AbortSignal) {
      return transport.request(`${prefix}/trips?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, (body) => {
        const value = object(body); const page = object(value.page);
        if (!Array.isArray(value.items) || value.items.length > 50 || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("INVALID_TRIP_PAGE");
        return { items: value.items.map(decodeDispatcherTrip), nextCursor: page.nextCursor as string | null };
      }, undefined, signal);
    },
    read(id: string, signal?: AbortSignal) { return transport.request(tripPath(id), decodeDispatcherTrip, undefined, signal); },
    create(request: TripCreateRequest, idempotencyKey: string) {
      return recovery.run({kind:'CREATE_TRIP',body:request},idempotencyKey,decodeDispatcherTrip);
    },
    cancel(id: string, etag: string, idempotencyKey: string) {
      tripPath(id);
      return recovery.run({kind:'CANCEL_TRIP',resourceId:id,expectedTag:etag,body:{reasonCode:'SYNTHETIC_REQUESTER_CANCELLED'}},idempotencyKey,(body) => {
        const value = object(body); const receipt = object(value.receipt);
        const trip: DispatcherTrip = decodeDispatcherTrip(value.trip);
        if (trip.tripId !== id || trip.lifecycle !== "CANCELLED" || !["APPLIED", "REPLAYED"].includes(String(receipt.outcome)) || receipt.resourceVersion !== trip.version) throw new Error("INVALID_COMMAND_RECEIPT");
        return trip;
      });
    },
  });
}
