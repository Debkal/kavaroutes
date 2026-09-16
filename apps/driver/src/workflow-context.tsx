import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyWorkflowCommand, createNotificationRecovery, createSyntheticWorkflow, type SyntheticWorkflow, type WorkflowCommand } from "@kavaroutes/driver-core";
import { loadSyntheticWorkflow, manualSyntheticSync, resetSyntheticWorkflow, saveSyntheticWorkflow, startSyntheticTracking, stopSyntheticTracking, trackingStatus, watchSyntheticVehicleMotion,
  readCloudPrecheckCommand, prepareCloudPrecheckCommand, recordCloudPrecheckOutcome, readCloudDefectPhotos, openCloudCommandStore, openCloudSignatureStore } from "./nativeActions";
import { requestSyntheticShiftStartReceipt, restoreSyntheticAuthentication } from "./synthetic-server";
import type { DriverItinerary } from "@kavaroutes/api-contracts/client-web";
import { createCloudDriverApi, privateCloudDriver, toDriverPolicy, decodeCloudItinerary } from "./cloud-server";
import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";
import { adoptCloudPrecheck, buildCloudPrecheckRequest } from "./cloud-precheck";
import type { DriverActionBatch } from "@kavaroutes/api-contracts/client-web";
import type { DriverSignatureRequest } from "@kavaroutes/api-contracts/client-web";
import {randomUUID} from 'expo-crypto';
import {openCloudPostcheckStore,openCloudFinishStore} from './nativeActions';
import {recoverCloudFinish,adoptCloudFinish} from './cloud-finish';
import {AppState} from 'react-native';

interface WorkflowContextValue {
  readonly state: SyntheticWorkflow;
  readonly ready: boolean;
  readonly error: string | undefined;
  readonly itinerary: DriverItinerary | null;
  readonly cloudPrototype: boolean;
  readonly dispatch: (command: WorkflowCommand) => Promise<SyntheticWorkflow>;
  readonly startShift: () => Promise<SyntheticWorkflow>;
  readonly recoverUpdates: (reason: "notification" | "foreground" | "start" | "reconnect", data?: unknown) => Promise<{ readonly outcome: "ignored" | "synchronized"; readonly detail: string }>;
  readonly reset: () => Promise<void>;
  readonly cloudAction: (legId: string, command: DriverActionBatch["items"][number]["command"], details?: Record<string, unknown>) => Promise<void>;
  readonly syncCloudActions: () => Promise<void>;
  readonly cloudSignature: (legId: string,request: DriverSignatureRequest) => Promise<void>;
  readonly reviewCloudRejections: () => Promise<void>;
  readonly syncCloudFinish:()=>Promise<void>;
  readonly sendSyntheticReturnSample:(fixture:'AT_RETURN'|'OUTSIDE_RETURN'|'INACCURATE')=>Promise<void>;
}
const WorkflowContext = createContext<WorkflowContextValue | null>(null);

export function WorkflowProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<SyntheticWorkflow>(createSyntheticWorkflow);
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [itinerary, setItinerary] = useState<DriverItinerary | null>(null);
  const cloudApi = useMemo(() => privateCloudDriver ? createCloudDriverApi() : null, []);
  const startFlight = useRef<Promise<SyntheticWorkflow> | null>(null);
  const syncFlight = useRef<Promise<void> | null>(null);
  const syntheticSampleFlight=useRef<Promise<void>|null>(null);
  const collectionStopped=useRef(false);
  const startPrototypeCollection=async()=>{
    if(!cloudApi)return startSyntheticTracking();
    // The private cloud lane never starts the real device GPS task.
    await stopSyntheticTracking();collectionStopped.current=false;
    return {active:true,state:'Synthetic transmission',detail:'Foreground fixture samples only; no device GPS.'};
  };
  const commitState = async (next: SyntheticWorkflow) => {
    await saveSyntheticWorkflow(next); stateRef.current = next; setState(next); setError(undefined); return next;
  };
  const recoverCloudPrecheck = useCallback(async (workflow: SyntheticWorkflow) => {
    if (!cloudApi || !workflow.effectivePolicy || ["SIGNED_OUT", "SHIFT_STARTING"].includes(workflow.phase)) return workflow;
    const shift = (await cloudApi.getShift(workflow.effectivePolicy.assignmentId)).value;
    if (shift.shiftGeneration !== workflow.shiftGeneration || shift.effectivePolicy.canonicalDigest !== workflow.effectivePolicy.canonicalDigest) throw new Error("SHIFT_POLICY_BINDING_CHANGED");
    if (workflow.shiftReference && workflow.shiftReference !== shift.shiftReference) throw new Error("SHIFT_REFERENCE_CHANGED");
    workflow = { ...workflow, shiftReference: shift.shiftReference, lastActionSequence: shift.lastActionSequence };
    const finishStore=await openCloudFinishStore();
    // Resolve original closure identity before considering another action or precheck.
    let finish=await recoverCloudFinish(cloudApi,finishStore,shift.shiftReference,stopSyntheticTracking);
    workflow=adoptCloudFinish(workflow,finish);
    if(finish.collectionStopped||finish.lifecycle==='SHIFT_ENDED')return workflow;
    const postStore=await openCloudPostcheckStore(),post=await postStore.read(shift.shiftReference);
    if(post?.state==='PENDING'){
      try{await postStore.record(shift.shiftReference,post.key,(await cloudApi.submitPostcheck(shift.shiftReference,post.request,post.key)).value);}
      catch(cause){if(!(cause instanceof DevelopmentApiError)||![400,401,403,404,409,412,413,415,422].includes(cause.status))throw cause;await postStore.record(shift.shiftReference,post.key,null);}
      finish=(await cloudApi.getClosure(shift.shiftReference)).value;workflow=adoptCloudFinish(workflow,finish);
    }
    if (shift.lifecycle !== "ACTIVE") throw new Error("The server shift needs review or has ended. No new trip actions are allowed.");
    const pending = await readCloudPrecheckCommand(shift.shiftReference);
    if (pending?.state === "PENDING") {
      try {
        const receipt = (await cloudApi.submitPrecheck(shift.shiftReference, pending.request, pending.key)).value;
        await recordCloudPrecheckOutcome(shift.shiftReference, pending.key, receipt);
        return adoptCloudPrecheck(workflow, receipt);
      } catch (cause) {
        if (!(cause instanceof DevelopmentApiError) || ![400, 401, 403, 404, 409, 412, 413, 415, 422].includes(cause.status)) throw cause;
        await recordCloudPrecheckOutcome(shift.shiftReference, pending.key, null);
        // Definitive rejection is durable, not an endless pending retry or completion.
        return { ...workflow, lastReceipt: "Server rejected the saved vehicle submission. Review and correct the controls before submitting again." };
      }
    }
    return shift.precheck && ["POLICY_RESOLVED", "PRECHECK_REQUIRED", "PRECHECK_OFFERED", "READY", "BLOCKED_CRITICAL_DEFECT"].includes(workflow.phase)
      ? adoptCloudPrecheck(workflow, shift.precheck) : workflow;
  }, [cloudApi]);
  const startReceipt = useCallback(async (workflow: SyntheticWorkflow, manifest: DriverItinerary | null) => {
    if (!cloudApi) return requestSyntheticShiftStartReceipt(workflow.authoritativeVersion);
    void manifest;
    const store = await openCloudCommandStore(); const pending = await store.start();
    if (!pending || pending.state === "REJECTED") throw new Error("Original shift command is unavailable. Review required; no replacement shift was created.");
    let receipt = pending.receipt;
    if (!receipt) {
      try { receipt = (await cloudApi.startShift(pending.request)).value; await store.recordStart(pending.request.idempotencyKey, receipt); }
      catch (cause) { if (cause instanceof DevelopmentApiError && [400,401,403,404,409,412,422].includes(cause.status)) await store.recordStart(pending.request.idempotencyKey,null); throw cause; }
    } else {
      const existing = (await cloudApi.getShift(pending.request.assignmentId)).value;
      if (existing.shiftReference !== receipt.shiftReference || existing.shiftGeneration !== receipt.shiftGeneration || existing.lifecycle !== "ACTIVE") throw new Error("Accepted shift needs review. No replacement shift was created.");
    }
    return { outcome: "ACCEPTED" as const, resourceVersion: receipt.resourceVersion,
      effectivePolicy: toDriverPolicy(receipt.effectivePolicy), shiftGeneration: receipt.shiftGeneration, shiftReference: receipt.shiftReference };
  }, [cloudApi]);
  const runCloudSync = async () => {
    if (!cloudApi) throw new Error("CLOUD_QUEUE_NOT_ENABLED");
    await cloudApi.authenticate(); const workflow = stateRef.current;
    if (!workflow.shiftReference || !workflow.effectivePolicy) throw new Error("RECOVER_SHIFT_BINDING_FIRST");
    const store = await openCloudCommandStore(); const queued = await store.actions(workflow.shiftReference);
    const proofs=await openCloudSignatureStore();
    for(const proof of await proofs.commands(workflow.shiftReference)) {
      if(proof.state!=="PENDING")continue;
      try {
        const receipt=(await cloudApi.submitSignature(proof.shift,proof.leg,proof.request,proof.key)).value;
        await proofs.record(proof,receipt);
      } catch(cause) {
        if(cause instanceof DevelopmentApiError && [400,401,403,404,409,412,413,422].includes(cause.status)) {
          await proofs.record(proof,null,cause.code);
          // A rejected proof is retained, never converted to acceptance. Refresh before a corrected capture.
        } else throw cause;
      }
    }
    let rejection: string | undefined;
    for (const action of queued) {
      if (action.state === "REJECTED") { if(action.reviewed)continue; rejection = action.receipt?.items[0]?.code ?? "REVIEW_REQUIRED"; break; }
      if (action.state === "ACCEPTED") continue;
      const receipt = (await cloudApi.submitActions(action.request, action.batchKey)).value;
      await store.recordAction(action, receipt);
      if (receipt.items[0]?.outcome === "REJECTED") { rejection = receipt.items[0].code; break; }
    }
    const savedStart = await store.start();
    const manifest = (await cloudApi.getItinerary(savedStart?.request.serviceDate)).value;
    await store.saveManifest(manifest); setItinerary(manifest);
    const server = (await cloudApi.getShift(workflow.effectivePolicy.assignmentId)).value;
    if (server.shiftReference !== workflow.shiftReference || server.shiftGeneration !== workflow.shiftGeneration) throw new Error("SHIFT_BINDING_CHANGED");
    if(server.lifecycle!=="ACTIVE")throw new Error("SHIFT_REQUIRES_REVIEW");
    await commitState({ ...stateRef.current, authoritativeVersion: server.resourceVersion, lastActionSequence: server.lastActionSequence,
      lastReceipt: rejection ? `Server rejected trip action: ${rejection}. Review required; no completion was recorded.` : "Saved trip actions recovered from server receipts." });
    if (rejection) { setError(`Recorded trip rejection: ${rejection}. Review before continuing.`); throw new Error(rejection); }
  };
  const syncCloudActions = () => {
    syncFlight.current ??= runCloudSync().catch(cause => { setError("Trip submission is not accepted yet. Its original identity remains saved for recovery."); throw cause; }).finally(() => { syncFlight.current = null; });
    return syncFlight.current;
  };
  const syncCloudFinish=async()=>{
    const current=stateRef.current;if(!cloudApi||!current.shiftReference)return;
    try{
      const view=await recoverCloudFinish(cloudApi,await openCloudFinishStore(),current.shiftReference,stopSyntheticTracking);
      if(view.collectionStopped||view.lifecycle==='SHIFT_ENDED')collectionStopped.current=true;
      if(collectionStopped.current&&!view.collectionStopped&&view.lifecycle!=='SHIFT_ENDED')return;
      await commitState(adoptCloudFinish(stateRef.current,view));
    }catch(cause){setError('Server finish status is unavailable. Saved requests remain pending until their original receipts are recovered.');throw cause;}
  };
  const sendSyntheticReturnSample=async(fixture:'AT_RETURN'|'OUTSIDE_RETURN'|'INACCURATE')=>{
    if(syntheticSampleFlight.current)return syntheticSampleFlight.current;
    const send=async()=>{
    const current=stateRef.current;
    if(!cloudApi||!current.shiftReference||!current.shiftGeneration||collectionStopped.current)throw new Error('RECOVER_SHIFT_FIRST');
    const view=(await cloudApi.getClosure(current.shiftReference)).value;
    if(view.collectionStopped||view.lifecycle!=='ACTIVE'||collectionStopped.current)throw new Error('SAMPLE_NOT_ALLOWED');
    const store=await openCloudFinishStore();
    await store.prepare(current.shiftReference,'LOCATION',{shiftGeneration:current.shiftGeneration,samples:[{sampleId:randomUUID(),sequence:(view.sample?.sequence??0)+1,fixture,capturedAt:new Date().toISOString()}]});
    await syncCloudFinish();
    };
    syntheticSampleFlight.current=send().finally(()=>{syntheticSampleFlight.current=null;});
    return syntheticSampleFlight.current;
  };
  const cloudAction = async (legId: string, command: DriverActionBatch["items"][number]["command"], details?: Record<string, unknown>) => {
    if (!cloudApi || stateRef.current.moving) throw new Error("PARK_VEHICLE_TO_CONTINUE");
    const workflow = stateRef.current;
    if (!workflow.shiftReference || !workflow.effectivePolicy || !["READY","ITINERARY_ACTIVE"].includes(workflow.phase)) throw new Error("SERVER_PRECHECK_REQUIRED");
    const store = await openCloudCommandStore();
    if((await (await openCloudSignatureStore()).commands(workflow.shiftReference)).some(p=>p.state==="PENDING"))throw new Error("RECOVER_PRECEDING_SIGNATURE");
    const savedManifest = await store.manifest(); const manifest = savedManifest ? decodeCloudItinerary(savedManifest) : itinerary;
    if (!manifest) throw new Error("AUTHENTICATED_MANIFEST_REQUIRED");
    const leg = manifest.legs.find(item => item.tripLegId === legId && item.assignmentId === workflow.effectivePolicy!.assignmentId);
    if (!leg?.execution?.expectedTag) throw new Error("ASSIGNED_DISPATCHED_EXECUTION_REQUIRED");
    await store.enqueue({ shiftReference: workflow.shiftReference, shiftGeneration: workflow.shiftGeneration, serverSequence: workflow.lastActionSequence ?? 0,
      resourceReference: legId, expectedTag: leg.execution.expectedTag, command, ...(details ? { details } : {}) });
    await syncCloudActions();
  };
  const cloudSignature = async (legId: string,request: DriverSignatureRequest) => {
    const workflow=stateRef.current;
    if(!cloudApi || workflow.moving || !workflow.shiftReference || !["READY","ITINERARY_ACTIVE"].includes(workflow.phase) || request.shiftGeneration!==workflow.shiftGeneration)throw new Error("PARK_AND_RECOVER_SHIFT_FIRST");
    const commands=await openCloudCommandStore();
    if((await commands.actions(workflow.shiftReference)).some(a=>a.state==="PENDING" || a.state==="REJECTED" && !a.reviewed))throw new Error("RECOVER_OR_REVIEW_PRECEDING_ACTION");
    const manifest=await commands.manifest();
    if(!manifest?.legs.some(l=>l.tripLegId===legId && l.assignmentId===workflow.effectivePolicy?.assignmentId))throw new Error("ASSIGNED_LEG_REQUIRED");
    const proofs=await openCloudSignatureStore();const saved=await proofs.prepare(workflow.shiftReference,legId,request);
    await syncCloudActions();
    const result=(await proofs.commands(workflow.shiftReference)).find(p=>p.request.evidenceId===saved.request.evidenceId);
    if(result?.state!=="ACCEPTED")throw new Error(result?.rejectionCode ?? "SIGNATURE_NOT_ACCEPTED");
  };
  const reviewCloudRejections = async () => {
    if(!cloudApi || stateRef.current.moving)throw new Error("PARK_TO_REVIEW");
    try { await syncCloudActions(); } catch { /* Only the explicit checks below may retire a terminal rejection. */ }
    const w=stateRef.current;if(!w.shiftReference || !w.effectivePolicy)throw new Error("SHIFT_REQUIRED");
    const s=(await cloudApi.getShift(w.effectivePolicy.assignmentId)).value;
    if(s.lifecycle!=="ACTIVE" || s.shiftReference!==w.shiftReference || s.shiftGeneration!==w.shiftGeneration)throw new Error("SHIFT_REQUIRES_REVIEW");
    const store=await openCloudCommandStore();const original=await store.start();
    const refreshed=(await cloudApi.getItinerary(original?.request.serviceDate)).value;await store.saveManifest(refreshed);setItinerary(refreshed);
    await store.reviewRejections(w.shiftReference,s.lastActionSequence);await syncCloudActions();
  };
  useEffect(() => { void loadSyntheticWorkflow().then(async (loaded) => {
    stateRef.current = loaded; setState(loaded);
    if(loaded.phase==='EMERGENCY_STOPPED'||loaded.phase==='SHIFT_ENDED')await stopSyntheticTracking();
    let remoteItinerary: DriverItinerary | null = null;
    if (cloudApi) {
      try {
        await cloudApi.authenticate();
        const store = await openCloudCommandStore(); const priorStart = await store.start();
        remoteItinerary = (await cloudApi.getItinerary(priorStart?.request.serviceDate)).value;
        await store.saveManifest(remoteItinerary);
      } catch (cause) {
        if (!(cause instanceof DevelopmentApiError) || cause.code !== "BACKEND_UNAVAILABLE" || !loaded.shiftReference) throw cause;
        const cached = await (await openCloudCommandStore()).manifest(); if (!cached) throw cause;
        setItinerary(decodeCloudItinerary(cached)); setError("Offline cached itinerary. Saved commands are pending until server receipt recovery."); setReady(true); return;
      }
      setItinerary(remoteItinerary);
    }
    let recovered = loaded;
    if (loaded.phase === "SHIFT_STARTING") {
      let native = await trackingStatus();
      let serverConfirmed = false;
      try {
        const server = cloudApi ? await startReceipt(loaded, remoteItinerary) : native.active ? await startReceipt(loaded, remoteItinerary) : null;
        serverConfirmed = server !== null;
        if (cloudApi && server && !native.active) native = await startPrototypeCollection();
        recovered = applyWorkflowCommand(loaded, native.active && server
          ? { type: "START_SHIFT_ACCEPTED", effectivePolicy: server.effectivePolicy, ...(server.shiftGeneration ? { shiftGeneration: server.shiftGeneration } : {}), ...("shiftReference" in server && typeof server.shiftReference === "string" ? { shiftReference: server.shiftReference } : {}) }
          : { type: "START_SHIFT_FAILED", reason: "TRACKING_START_FAILED" });
        if (!server) await stopSyntheticTracking();
      } catch (cause) {
        if (cloudApi && (serverConfirmed || cause instanceof DevelopmentApiError && cause.code === "OUTCOME_UNKNOWN")) {
          recovered = loaded;
          setError("Shift outcome is unknown. KavaRoutes will retry the same command identity when this prototype reopens.");
        } else {
          if (native.active) await stopSyntheticTracking();
          recovered = applyWorkflowCommand(loaded, { type: "START_SHIFT_FAILED", reason: "TRACKING_START_FAILED" });
          setError(cause instanceof Error ? cause.message : "The pending cloud shift could not be recovered");
        }
      }
      await saveSyntheticWorkflow(recovered);
    } else if (loaded.tracking === "TRACKING") await trackingStatus();
    if (cloudApi) {
      recovered = await recoverCloudPrecheck(recovered);
      await saveSyntheticWorkflow(recovered);
    }
    stateRef.current = recovered; setState(recovered); setReady(true);
    if (cloudApi && recovered.shiftReference && ["READY","ITINERARY_ACTIVE"].includes(recovered.phase)) {
      try { await syncCloudActions(); } catch { /* Persisted pending/rejected queue remains visible, not accepted. */ }
    }
  }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Unable to open protected test data"); setReady(!cloudApi); }); }, [cloudApi, startReceipt, recoverCloudPrecheck]);
  useEffect(() => {
    if (cloudApi || !ready || state.tracking !== "TRACKING") return;
    let active = true; let write = Promise.resolve();
    const subscription = watchSyntheticVehicleMotion({ moving: stateRef.current.moving, stationaryConfirmations: 0 }, (motion) => {
      if (!active || motion.moving === stateRef.current.moving) return;
      write = write.then(async () => {
        if (!active || motion.moving === stateRef.current.moving) return;
        const current = applyWorkflowCommand(stateRef.current, { type: "SET_MOVING", moving: motion.moving });
        await saveSyntheticWorkflow(current); stateRef.current = current; setState(current);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not update vehicle motion"));
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not detect vehicle motion"); return null; });
    return () => { active = false; void subscription.then((value) => value?.remove()); };
  }, [ready, state.tracking]);
  useEffect(()=>{
    if(!cloudApi||!ready||state.tracking!=='TRACKING'||!state.shiftReference)return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      if(!active||collectionStopped.current||stateRef.current.tracking!=='TRACKING')return;
      if(AppState.currentState==='background'||AppState.currentState==='inactive'){
        timer=setTimeout(()=>void tick(),20_000);return;
      }
      // Foreground-only test transmission deliberately stops during suspension/offline.
      // Never invent return arrival: automatic samples always mean OUTSIDE_RETURN.
      try{await sendSyntheticReturnSample('OUTSIDE_RETURN');}catch{/* Dispatch clock independently marks missing updates. */}
      if(active)timer=setTimeout(()=>void tick(),20_000);
    };
    timer=setTimeout(()=>void tick(),20_000);return()=>{active=false;clearTimeout(timer);};
  },[cloudApi,ready,state.tracking,state.shiftReference]);
  const dispatch = async (command: WorkflowCommand) => {
    if(cloudApi&&command.type==='EMERGENCY_STOP'){
      // Device collection stops before storage or network access can block the action.
      collectionStopped.current=true;
      await stopSyntheticTracking();const current=stateRef.current;
      await commitState({...current,phase:'EMERGENCY_STOPPED',tracking:'EMERGENCY_STOPPED',moving:false,lastReceipt:'Location collection stopped on this device. Dispatch notification pending.'});
      if(!current.shiftReference)throw new Error('SHIFT_RECOVERY_REQUIRED_FOR_ALERT');
      const store=await openCloudFinishStore();await store.prepare(current.shiftReference,'EMERGENCY',{commandId:randomUUID(),shiftGeneration:current.shiftGeneration,expectedVersion:current.authoritativeVersion,kind:'EMERGENCY_STOP',reason:command.reason,parkedAttestation:false});
      try{await syncCloudFinish();}catch{setError('Location sharing stopped locally. Original emergency notification is saved for reconnect.');}return stateRef.current;
    }
    if(cloudApi&&command.type==='BEGIN_RETURN'){
      if(stateRef.current.moving)throw new Error('PARK_VEHICLE_TO_CONTINUE');await syncCloudActions();
      const current=stateRef.current,manifest=await(await openCloudCommandStore()).manifest();
      const assigned=manifest?.legs.filter(l=>l.assignmentId===current.effectivePolicy?.assignmentId)??[];
      if(!assigned.length||assigned.some(l=>!['COMPLETED','RIDER_NO_SHOW','CANCELLED'].includes(l.execution?.lifecycle??'')))throw new Error('COMPLETE_OR_RESOLVE_ASSIGNED_WORK_FIRST');
      const policy=current.effectivePolicy!;
      return commitState({...current,phase:[policy.postInspection.mode,policy.endOdometer.mode].includes('REQUIRED')?'POSTCHECK_REQUIRED':[policy.postInspection.mode,policy.endOdometer.mode].includes('OPTIONAL')?'POSTCHECK_OFFERED':'SIGNOFF_PENDING',lastReceipt:'Review assigned post-trip controls. No completion recorded yet.'});
    }
    if(cloudApi&&(command.type==='COMPLETE_POSTCHECK'||command.type==='SKIP_POSTCHECK')){
      const current=stateRef.current;if(current.moving||!current.shiftReference||!current.effectivePolicy||!['POSTCHECK_REQUIRED','POSTCHECK_OFFERED'].includes(current.phase))throw new Error('POSTCHECK_NOT_ACTIVE');
      const shift=(await cloudApi.getShift(current.effectivePolicy.assignmentId)).value;
      const selected=itinerary?.legs.find(l=>l.assignmentId===current.effectivePolicy!.assignmentId);if(!selected?.vehicleId)throw new Error('ASSIGNED_VEHICLE_REQUIRED');
      const store=await openCloudPostcheckStore();let saved=await store.read(current.shiftReference);
      if(!saved||saved.state==='REJECTED'){
        const photos=await readCloudDefectPhotos(Object.values(current.postCheck).flatMap(a=>a.photoDigest?[a.photoDigest]:[]));
        // Reuse form validation; only server-pinned post modes choose the actual command policy.
        const request=buildCloudPrecheckRequest({...current,preCheck:current.postCheck},{...shift,effectivePolicy:{...shift.effectivePolicy,preInspection:shift.effectivePolicy.postInspection,startOdometer:shift.effectivePolicy.endOdometer}},selected.vehicleId,{...command,type:command.type==='SKIP_POSTCHECK'?'SKIP_PRECHECK':'COMPLETE_PRECHECK'},photos);
        saved=await store.prepare(current.shiftReference,request);
      }
      if(saved.state==='PENDING'){try{const receipt=(await cloudApi.submitPostcheck(current.shiftReference,saved.request,saved.key)).value;await store.record(current.shiftReference,saved.key,receipt);}catch(cause){if(cause instanceof DevelopmentApiError&&[400,401,403,404,409,412,413,415,422].includes(cause.status))await store.record(current.shiftReference,saved.key,null);throw cause;}}
      await syncCloudFinish();return stateRef.current;
    }
    if(cloudApi&&command.type==='SIGN_OFF'){
      const current=stateRef.current;if(current.moving||!current.shiftReference||!current.effectivePolicy)throw new Error('PARK_AND_RECOVER_SHIFT_FIRST');
      if(command.override)throw new Error('DRIVER_CANNOT_OVERRIDE_RETURN');
      const view=(await cloudApi.getClosure(current.shiftReference)).value,store=await openCloudFinishStore();
      await store.prepare(current.shiftReference,'CLOSE',{commandId:randomUUID(),shiftGeneration:current.shiftGeneration,expectedVersion:view.resourceVersion,kind:'SIGN_OFF',reason:'NORMAL_SIGN_OFF',parkedAttestation:true,...(view.returnMode!=='DISABLED'&&view.sample?{sampleId:view.sample.sampleId}:{})});
      await syncCloudFinish();return stateRef.current;
    }
    if (cloudApi && ["COMPLETE_PRECHECK", "SKIP_PRECHECK", "CONFIRM_VEHICLE"].includes(command.type)) {
      const workflow = stateRef.current;
      if (workflow.moving) throw new Error("PARK_VEHICLE_TO_CONTINUE");
      if (!workflow.effectivePolicy || !["POLICY_RESOLVED", "PRECHECK_REQUIRED", "PRECHECK_OFFERED", "READY", "BLOCKED_CRITICAL_DEFECT"].includes(workflow.phase)) throw new Error("PRECHECK_NOT_ACTIVE");
      const selected = itinerary?.legs.find(leg => leg.assignmentId === workflow.effectivePolicy!.assignmentId);
      if (!selected?.vehicleId) throw new Error("Assigned cloud vehicle is unavailable. Refresh your itinerary.");
      if (command.type === "CONFIRM_VEHICLE" && (workflow.effectivePolicy.preInspection.mode !== "DISABLED" || workflow.effectivePolicy.startOdometer.mode !== "DISABLED")) {
        return commitState({ ...applyWorkflowCommand(workflow, command), lastReceipt: "Assigned vehicle selected. Submit its controls for server acceptance." });
      }
      if (command.type !== "CONFIRM_VEHICLE" && !workflow.vehicleConfirmed) throw new Error("VEHICLE_CONFIRMATION_REQUIRED");
      const shift = (await cloudApi.getShift(workflow.effectivePolicy.assignmentId)).value;
      if (shift.shiftGeneration !== workflow.shiftGeneration || shift.effectivePolicy.canonicalDigest !== workflow.effectivePolicy.canonicalDigest || shift.lifecycle !== "ACTIVE") throw new Error("SHIFT_POLICY_BINDING_CHANGED");
      const existing = await readCloudPrecheckCommand(shift.shiftReference);
      if (shift.precheck && existing?.state !== "PENDING") return commitState(adoptCloudPrecheck(workflow, shift.precheck));
      const typed = command as Extract<WorkflowCommand, { type: "COMPLETE_PRECHECK" | "SKIP_PRECHECK" | "CONFIRM_VEHICLE" }>;
      const photoDigests = [...new Set(Object.values(workflow.preCheck).flatMap(answer => answer.photoDigest ? [answer.photoDigest] : []))];
      const request = existing?.state === "PENDING" ? existing.request : buildCloudPrecheckRequest(workflow, shift, selected.vehicleId, typed, await readCloudDefectPhotos(photoDigests));
      const pending = await prepareCloudPrecheckCommand(shift.shiftReference, request);
      try {
        const receipt = (await cloudApi.submitPrecheck(shift.shiftReference, pending.request, pending.key)).value;
        await recordCloudPrecheckOutcome(shift.shiftReference, pending.key, receipt);
        return commitState(adoptCloudPrecheck(workflow, receipt));
      } catch (cause) {
        if (cause instanceof DevelopmentApiError && [400, 401, 403, 404, 409, 412, 413, 415, 422].includes(cause.status)) await recordCloudPrecheckOutcome(shift.shiftReference, pending.key, null);
        setError("Vehicle check is not accepted yet. Retry to recover the saved submission."); throw cause;
      }
    }
    if (cloudApi && ["ADVANCE_STOP", "SAVE_SIGNATURE", "COMPLETE_POSTCHECK", "SKIP_POSTCHECK", "SIGN_OFF", "PROPOSE_REORDER", "DECIDE_PROPOSAL", "REPORT_STOP_EXCEPTION", "BEGIN_RETURN", "SYNC_OUTBOX"].includes(command.type)) {
      throw new Error("This cloud command is still being connected. No server acceptance was recorded.");
    }
    const current = applyWorkflowCommand(stateRef.current, command);
    if (command.type === "EMERGENCY_STOP") await stopSyntheticTracking();
    if (command.type === "SIGN_OFF" && current.phase === "SHIFT_ENDED") await stopSyntheticTracking();
    await saveSyntheticWorkflow(current); stateRef.current = current; setState(current); setError(undefined); return current;
  };
  const startShiftTask = async () => {
    if (cloudApi) {
      if(stateRef.current.phase==='SHIFT_ENDED'){
        const ended=stateRef.current;if(!ended.shiftReference)throw new Error('ACCEPTED_SIGN_OFF_REQUIRED');
        const closure=(await cloudApi.getClosure(ended.shiftReference)).value;
        await(await openCloudCommandStore()).archiveEndedShift(closure);
        await commitState(createSyntheticWorkflow());
      }
      await cloudApi.authenticate(); const manifest = (await cloudApi.getItinerary()).value; setItinerary(manifest);
      await (await openCloudCommandStore()).saveManifest(manifest);
      const leg = manifest.legs.find(l=>!['COMPLETED','RIDER_NO_SHOW','CANCELLED'].includes(l.execution?.lifecycle??'')); if (!leg) throw new Error("No unfinished assigned cloud work is available for today.");
      await (await openCloudCommandStore()).prepareStart({ assignmentId: leg.assignmentId, assignmentVersion: leg.assignmentVersion, serviceDate: manifest.serviceDate });
    }
    await dispatch({ type: "REQUEST_START_SHIFT" });
    let serverConfirmed = false;
    try {
      if (!cloudApi) { const tracking = await startSyntheticTracking(); if (!tracking.active) { await dispatch({ type: "START_SHIFT_FAILED", reason: "PERMISSION_DENIED" }); throw new Error(tracking.detail); } }
      let manifest = itinerary;
      if (cloudApi) { manifest = (await cloudApi.getItinerary()).value; setItinerary(manifest); }
      const server = await startReceipt(stateRef.current, manifest);
      serverConfirmed = true;
      if (cloudApi) { const tracking = await startPrototypeCollection(); if (!tracking.active) throw new Error(tracking.detail); }
      return await dispatch({ type: "START_SHIFT_ACCEPTED", effectivePolicy: server.effectivePolicy,
        ...(server.shiftGeneration ? { shiftGeneration: server.shiftGeneration } : {}), ...("shiftReference" in server && typeof server.shiftReference === "string" ? { shiftReference: server.shiftReference } : {}) });
    } catch (cause) {
      const unknownCloudOutcome = cloudApi && (serverConfirmed || cause instanceof DevelopmentApiError && cause.code === "OUTCOME_UNKNOWN");
      if (!unknownCloudOutcome) {
        await stopSyntheticTracking();
        if (stateRef.current.phase === "SHIFT_STARTING") await dispatch({ type: "START_SHIFT_FAILED", reason: "TRACKING_START_FAILED" });
      }
      setError(cause instanceof Error ? cause.message : "The shift did not start");
      throw cause;
    }
  };
  const startShift = () => {
    startFlight.current ??= startShiftTask().finally(() => { startFlight.current = null; });
    return startFlight.current;
  };
  const reset = async () => { if (cloudApi) throw new Error("Cloud reset requires reconciliation; pending work was not discarded."); await resetSyntheticWorkflow(); const fresh = createSyntheticWorkflow(); stateRef.current = fresh; setState(fresh); setError(undefined); };
  const recoverUpdates = useCallback(async (reason: "notification" | "foreground" | "start" | "reconnect", data?: unknown) => {
    let detail = "The notification was ignored because its data did not match the safe KavaRoutes envelope.";
    const recovery = createNotificationRecovery({
      authenticate: cloudApi ? async () => (await cloudApi.authenticate()).value : restoreSyntheticAuthentication,
      openSafeUpdatesEntry: async () => Promise.resolve(),
      synchronize: async () => {
        if (cloudApi) {
          const store = await openCloudCommandStore(); const original = await store.start();
          const refreshed = (await cloudApi.getItinerary(original?.request.serviceDate)).value; setItinerary(refreshed);
          await (await openCloudCommandStore()).saveManifest(refreshed);
          let workflow = stateRef.current;
          if (workflow.phase === "SHIFT_STARTING") {
            const accepted = await startReceipt(workflow,refreshed);const tracking = await startPrototypeCollection();
            if (!tracking.active) throw new Error(tracking.detail);
            workflow = applyWorkflowCommand(workflow,{ type: "START_SHIFT_ACCEPTED",effectivePolicy: accepted.effectivePolicy,
              ...(accepted.shiftGeneration ? { shiftGeneration: accepted.shiftGeneration } : {}),
              ...("shiftReference" in accepted && typeof accepted.shiftReference === "string" ? { shiftReference: accepted.shiftReference } : {}) });
          }
          const recovered = await recoverCloudPrecheck(workflow);
          await saveSyntheticWorkflow(recovered); stateRef.current = recovered; setState(recovered); setReady(true); setError(undefined);
          if (recovered.shiftReference && ["READY","ITINERARY_ACTIVE"].includes(recovered.phase)) await syncCloudActions();
          detail = "The persisted Driver itinerary and vehicle receipt were recovered from the private cloud. Trip actions retain their actual pending state.";
          return { projectionDigest: stateRef.current.effectivePolicy?.canonicalDigest ?? "0".repeat(64) };
        }
        const result = await manualSyntheticSync("ACCEPTED"); detail = result.detail;
        const next = applyWorkflowCommand(stateRef.current, { type: "SYNC_OUTBOX", outcome: result.outcome });
        await saveSyntheticWorkflow(next); stateRef.current = next; setState(next);
        return { projectionDigest: next.effectivePolicy?.canonicalDigest ?? "0".repeat(64) };
      },
    });
    const recovered = await recovery.recover(reason, data);
    return Object.freeze({ outcome: recovered.outcome, detail });
  }, [cloudApi, recoverCloudPrecheck,startReceipt]);
  const value = useMemo(() => ({ state, ready, error, itinerary, cloudPrototype: privateCloudDriver, dispatch, startShift, recoverUpdates, reset, cloudAction, syncCloudActions,cloudSignature,reviewCloudRejections,syncCloudFinish,sendSyntheticReturnSample }), [state, ready, error, itinerary, recoverUpdates]);
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
export function useWorkflow() { const value = useContext(WorkflowContext); if (!value) throw new Error("WORKFLOW_PROVIDER_REQUIRED"); return value; }
