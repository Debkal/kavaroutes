import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyWorkflowCommand, createNotificationRecovery, createSyntheticWorkflow, type SyntheticWorkflow, type WorkflowCommand } from "@kavaroutes/driver-core";
import { loadSyntheticWorkflow, manualSyntheticSync, resetSyntheticWorkflow, saveSyntheticWorkflow, startSyntheticTracking, stopSyntheticTracking, trackingStatus, watchSyntheticVehicleMotion } from "./nativeActions";
import { requestSyntheticShiftStartReceipt, restoreSyntheticAuthentication } from "./synthetic-server";

interface WorkflowContextValue {
  readonly state: SyntheticWorkflow;
  readonly ready: boolean;
  readonly error: string | undefined;
  readonly dispatch: (command: WorkflowCommand) => Promise<SyntheticWorkflow>;
  readonly startShift: () => Promise<SyntheticWorkflow>;
  readonly recoverUpdates: (reason: "notification" | "foreground" | "start" | "reconnect", data?: unknown) => Promise<{ readonly outcome: "ignored" | "synchronized"; readonly detail: string }>;
  readonly reset: () => Promise<void>;
}
const WorkflowContext = createContext<WorkflowContextValue | null>(null);

export function WorkflowProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<SyntheticWorkflow>(createSyntheticWorkflow);
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void loadSyntheticWorkflow().then(async (loaded) => {
    let recovered = loaded;
    if (loaded.phase === "SHIFT_STARTING") {
      const native = await trackingStatus(); const server = native.active ? await requestSyntheticShiftStartReceipt(loaded.authoritativeVersion) : null;
      recovered = applyWorkflowCommand(loaded, native.active && server
        ? { type: "START_SHIFT_ACCEPTED", effectivePolicy: server.effectivePolicy } : { type: "START_SHIFT_FAILED", reason: "TRACKING_START_FAILED" });
      await saveSyntheticWorkflow(recovered);
    } else if (loaded.tracking === "TRACKING") await trackingStatus();
    stateRef.current = recovered; setState(recovered); setReady(true);
  }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Unable to open protected test data"); setReady(true); }); }, []);
  useEffect(() => {
    if (!ready || state.tracking !== "TRACKING") return;
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
  const dispatch = async (command: WorkflowCommand) => {
    const current = applyWorkflowCommand(stateRef.current, command);
    if (command.type === "EMERGENCY_STOP") await stopSyntheticTracking();
    if (command.type === "SIGN_OFF" && current.phase === "SHIFT_ENDED") await stopSyntheticTracking();
    await saveSyntheticWorkflow(current); stateRef.current = current; setState(current); setError(undefined); return current;
  };
  const startShift = async () => {
    await dispatch({ type: "REQUEST_START_SHIFT" });
    try {
      const tracking = await startSyntheticTracking();
      if (!tracking.active) { await dispatch({ type: "START_SHIFT_FAILED", reason: "PERMISSION_DENIED" }); throw new Error(tracking.detail); }
      const server = await requestSyntheticShiftStartReceipt(stateRef.current.authoritativeVersion);
      return await dispatch({ type: "START_SHIFT_ACCEPTED", effectivePolicy: server.effectivePolicy });
    } catch (cause) {
      await stopSyntheticTracking();
      if (stateRef.current.phase === "SHIFT_STARTING") await dispatch({ type: "START_SHIFT_FAILED", reason: "TRACKING_START_FAILED" });
      setError(cause instanceof Error ? cause.message : "The shift did not start");
      throw cause;
    }
  };
  const reset = async () => { await resetSyntheticWorkflow(); const fresh = createSyntheticWorkflow(); stateRef.current = fresh; setState(fresh); setError(undefined); };
  const recoverUpdates = useCallback(async (reason: "notification" | "foreground" | "start" | "reconnect", data?: unknown) => {
    let detail = "The notification was ignored because its data did not match the safe KavaRoutes envelope.";
    const recovery = createNotificationRecovery({
      authenticate: restoreSyntheticAuthentication,
      openSafeUpdatesEntry: async () => Promise.resolve(),
      synchronize: async () => {
        const result = await manualSyntheticSync("ACCEPTED"); detail = result.detail;
        const next = applyWorkflowCommand(stateRef.current, { type: "SYNC_OUTBOX", outcome: result.outcome });
        await saveSyntheticWorkflow(next); stateRef.current = next; setState(next);
        return { projectionDigest: next.effectivePolicy?.canonicalDigest ?? "0".repeat(64) };
      },
    });
    const recovered = await recovery.recover(reason, data);
    return Object.freeze({ outcome: recovered.outcome, detail });
  }, []);
  const value = useMemo(() => ({ state, ready, error, dispatch, startShift, recoverUpdates, reset }), [state, ready, error, recoverUpdates]);
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
export function useWorkflow() { const value = useContext(WorkflowContext); if (!value) throw new Error("WORKFLOW_PROVIDER_REQUIRED"); return value; }
