import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyWorkflowCommand, createSyntheticWorkflow, type SyntheticWorkflow, type WorkflowCommand } from "@kavaroutes/driver-core";
import { loadSyntheticWorkflow, resetSyntheticWorkflow, saveSyntheticWorkflow, startSyntheticTracking, stopSyntheticTracking, trackingStatus } from "./nativeActions";
import { requestSyntheticShiftStartReceipt } from "./synthetic-server";

interface WorkflowContextValue {
  readonly state: SyntheticWorkflow;
  readonly ready: boolean;
  readonly error: string | undefined;
  readonly dispatch: (command: WorkflowCommand) => Promise<SyntheticWorkflow>;
  readonly startShift: () => Promise<SyntheticWorkflow>;
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
  const value = useMemo(() => ({ state, ready, error, dispatch, startShift, reset }), [state, ready, error]);
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
export function useWorkflow() { const value = useContext(WorkflowContext); if (!value) throw new Error("WORKFLOW_PROVIDER_REQUIRED"); return value; }
