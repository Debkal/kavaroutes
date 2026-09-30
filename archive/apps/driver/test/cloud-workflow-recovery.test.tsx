import { Text } from "react-native";
import { act, render, waitFor } from "@testing-library/react-native";
import { WorkflowProvider, useWorkflow } from "../src/workflow-context";
import { createSyntheticWorkflow, SYNTHETIC_ENTERPRISE_POLICY } from "../../../packages/driver-core/src/workflow";
import { DevelopmentApiError } from "@kavaroutes/api-contracts/private-development-transport";

const mockApi = { authenticate: jest.fn(async () => ({ value: "authenticated" })), getItinerary: jest.fn(async () => ({ value: { legs: [] } })),
  getShift: jest.fn(), getClosure:jest.fn(), submitSyntheticLocations:jest.fn(), submitPrecheck: jest.fn(), startShift: jest.fn(),submitActions: jest.fn() };
const mockFinishStore={list:jest.fn(async()=>[]),prepare:jest.fn(),record:jest.fn()};
jest.mock('expo-crypto',()=>({randomUUID:()=> '60000000-0000-4000-8000-000000000001'}));
const mockLoad = jest.fn(); const mockSave = jest.fn(async () => undefined);
const mockPending = jest.fn(); const mockRecord = jest.fn(async () => undefined);
const mockStore = { start: jest.fn(),saveManifest: jest.fn(async () => undefined),actions: jest.fn(),manifest: jest.fn(),
  prepareStart: jest.fn(),recordStart: jest.fn(async () => undefined),enqueue: jest.fn(),recordAction: jest.fn(async () => undefined) };
const mockTracking = jest.fn(async () => ({ active: true }));
jest.mock("@kavaroutes/driver-core", () => ({ ...jest.requireActual("../../../packages/driver-core/src/workflow"), createNotificationRecovery: (ports: any) => ({ recover: async () => { await ports.authenticate(); await ports.synchronize(); return { outcome: "synchronized" }; } }) }));
jest.mock("../src/cloud-server", () => ({ privateCloudDriver: true, createCloudDriverApi: () => mockApi, toDriverPolicy: (v: unknown) => v,decodeCloudItinerary: (v: unknown) => v }));
jest.mock("../src/synthetic-server", () => ({ requestSyntheticShiftStartReceipt: jest.fn(), restoreSyntheticAuthentication: jest.fn() }));
jest.mock("../src/nativeActions", () => ({ loadSyntheticWorkflow: () => mockLoad(), saveSyntheticWorkflow: (...a: any[]) => mockSave(...a),
  readCloudPrecheckCommand: () => mockPending(), recordCloudPrecheckOutcome: (...a: any[]) => mockRecord(...a),
  openCloudCommandStore: async () => mockStore,
  openCloudFinishStore:async()=>mockFinishStore,
  openCloudPostcheckStore:async()=>({read:async()=>null}),
  openCloudSignatureStore: async () => ({commands:async()=>[],record:jest.fn()}),
  startSyntheticTracking: () => mockTracking(),stopSyntheticTracking: jest.fn(),trackingStatus: jest.fn(async () => ({ active: false })), watchSyntheticVehicleMotion: jest.fn(async () => ({ remove: jest.fn() })) }));
let observed: ReturnType<typeof useWorkflow>;
function Probe() { observed = useWorkflow(); return <Text>{observed.ready ? observed.state.phase : "WAITING"}</Text>; }
const generation = "50000000-0000-4000-8000-000000000002"; const shiftReference = "50000000-0000-4000-8000-000000000001";
const vehicleId = "50000000-0000-4000-8000-000000000003";
const loaded = { ...createSyntheticWorkflow(), phase: "PRECHECK_REQUIRED", vehicleConfirmed: true, shiftGeneration: generation, effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY };
const receipt = { shiftReference, vehicleId, resourceVersion: 2, vehicleState: "READY", inspectionOutcome: "COMPLETED", odometerOutcome: "COMPLETED", odometer: 10420, fuelLevel: "FULL" };
const pending = { key: "precheck-original-key-0001", state: "PENDING", request: { shiftGeneration: generation, capturedAt: "original", photos: [] } };
beforeEach(() => {
  jest.clearAllMocks(); mockLoad.mockResolvedValue(loaded); mockPending.mockResolvedValue(pending);
  mockFinishStore.list.mockResolvedValue([]);
  mockApi.getClosure.mockResolvedValue({value:{shiftReference,shiftGeneration:generation,resourceVersion:2,lifecycle:'ACTIVE',collectionStopped:false,postcheck:null,lastEvent:null,returnResult:null}});
  mockStore.start.mockResolvedValue(null); mockStore.actions.mockResolvedValue([]);mockStore.manifest.mockResolvedValue(null);
  mockApi.authenticate.mockResolvedValue({ value: "authenticated" });mockApi.getItinerary.mockResolvedValue({ value: { legs: [] } });
  mockApi.getShift.mockResolvedValue({ value: { shiftReference, shiftGeneration: generation, resourceVersion: 2,
    lifecycle: "ACTIVE",lastActionSequence: 0, effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY, precheck: receipt } });
});
test("actual provider startup replays original pending inspection and persists server acceptance without starting another shift", async () => {
  mockApi.submitPrecheck.mockResolvedValue({ value: receipt }); const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(surface.getByText("READY")).toBeTruthy());
  expect(mockApi.submitPrecheck).toHaveBeenCalledWith(shiftReference, pending.request, pending.key);
  expect(mockRecord).toHaveBeenCalledWith(shiftReference, pending.key, receipt);
  expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ preInspectionOutcome: "COMPLETED", authoritativeVersion: 2 }));
  expect(mockApi.startShift).not.toHaveBeenCalled();
});
test("lost response remains pending and blocks ready access, then reopen recovers the same identity", async () => {
  mockApi.submitPrecheck.mockRejectedValue(new DevelopmentApiError(0, "OUTCOME_UNKNOWN"));
  const first = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(observed.error).toBeDefined()); expect(observed.ready).toBe(false); expect(mockRecord).not.toHaveBeenCalled();
  await first.unmount(); mockApi.submitPrecheck.mockResolvedValue({ value: receipt });
  const second = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(second.getByText("READY")).toBeTruthy());
  expect(mockApi.submitPrecheck.mock.calls.map(a => a[2])).toEqual([pending.key, pending.key]);
});
test("definitive rejection is recorded as rejection and does not manufacture completion", async () => {
  mockApi.submitPrecheck.mockRejectedValue(new DevelopmentApiError(422, "DEFECT_DETAILS_REQUIRED"));
  const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(surface.getByText("PRECHECK_REQUIRED")).toBeTruthy());
  expect(mockRecord).toHaveBeenCalledWith(shiftReference, pending.key, null); expect(observed.state.preCheckComplete).toBe(false);
});
test("already accepted server precheck is reread without a fresh command", async () => {
  mockPending.mockResolvedValue({ ...pending, state: "ACCEPTED", receipt });
  const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(surface.getByText("READY")).toBeTruthy()); expect(mockApi.submitPrecheck).not.toHaveBeenCalled();
});
test("actual startup queue keeps a lost action response pending and reopens with the exact batch/body before refreshing", async () => {
  mockPending.mockResolvedValue(null);
  const action = { batchKey: "original-batch-key",state: "PENDING",request: { shiftReference,shiftGeneration: generation,items: [{ clientActionId: "original-action",resourceReference: "actual-leg",sequence: 1 }] } };
  mockStore.actions.mockResolvedValue([action]);mockApi.submitActions.mockRejectedValue(new DevelopmentApiError(0,"OUTCOME_UNKNOWN"));
  const first = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(mockApi.submitActions).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(observed.error).toBeDefined());expect(mockStore.recordAction).not.toHaveBeenCalled();
  await first.unmount();
  const serverReceipt = { batchReference: "stable-batch",items: [{ clientItemId: "original-action",outcome: "APPLIED",resourceVersion: 2 }] };
  mockApi.submitActions.mockResolvedValue({ value: serverReceipt });
  const second = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(mockStore.recordAction).toHaveBeenCalledWith(action,serverReceipt));
  expect(mockApi.submitActions.mock.calls).toEqual([[action.request,action.batchKey],[action.request,action.batchKey]]);
  await waitFor(() => expect(observed.error).toBeUndefined()); expect(second.getByText("READY")).toBeTruthy();
});
test("pending start reuses the saved assignment/version/date/key rather than today's changed manifest; tracking waits for acceptance", async () => {
  mockLoad.mockResolvedValue({ ...createSyntheticWorkflow(),phase: "SHIFT_STARTING" });
  const original = { assignmentId: SYNTHETIC_ENTERPRISE_POLICY.assignmentId,assignmentVersion: 1,serviceDate: "2026-09-13",idempotencyKey: "original-start-key" };
  mockStore.start.mockResolvedValue({ state: "PENDING",request: original,receipt: null });
  let finish: (v: any) => void = () => undefined;
  mockApi.startShift.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mockApi.getShift.mockResolvedValue({ value: { shiftReference,shiftGeneration: generation,resourceVersion: 1,lastActionSequence: 0,lifecycle: "ACTIVE",effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY,precheck: null } });
  const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(mockApi.startShift).toHaveBeenCalledWith(original));expect(mockTracking).not.toHaveBeenCalled();
  await act(async () => finish({ value: { outcome: "APPLIED",shiftReference,shiftGeneration: generation,resourceVersion: 1,effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY } }));
  await waitFor(() => expect(surface.getByText("POLICY_RESOLVED")).toBeTruthy());
  expect(observed.state.shiftReference).toBe(shiftReference);expect(observed.state.shiftGeneration).toBe(generation);
  expect(mockStore.recordStart).toHaveBeenCalledWith(original.idempotencyKey,expect.objectContaining({ shiftReference }));
  expect(mockStore.prepareStart).not.toHaveBeenCalled();expect(mockTracking).not.toHaveBeenCalled();
});
test("offline action queues cached authenticated leg/ETag first and never manufactures a server receipt", async () => {
  mockPending.mockResolvedValue(null);
  mockStore.manifest.mockResolvedValue({ serviceDate: "2026-09-13",legs: [{ assignmentId: SYNTHETIC_ENTERPRISE_POLICY.assignmentId,tripLegId: "assigned-leg",execution: { expectedTag: '"server-tag"' } }] });
  const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(surface.getByText("READY")).toBeTruthy());
  await waitFor(() => expect(observed.state.lastReceipt).toBe("Saved trip actions recovered from server receipts."));
  mockApi.authenticate.mockRejectedValueOnce(new DevelopmentApiError(0,"BACKEND_UNAVAILABLE"));
  await act(async () => { await expect(observed.cloudAction("assigned-leg","MARK_EN_ROUTE")).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" }); });
  expect(mockStore.enqueue).toHaveBeenCalledWith(expect.objectContaining({ resourceReference: "assigned-leg",expectedTag: '"server-tag"',shiftReference,shiftGeneration: generation }));
  expect(mockStore.recordAction).not.toHaveBeenCalled();
});
test("manual reconnect recovers the same pending shift command after an unknown startup outcome", async () => {
  mockLoad.mockResolvedValue({ ...createSyntheticWorkflow(),phase: "SHIFT_STARTING" });
  const original = { assignmentId: SYNTHETIC_ENTERPRISE_POLICY.assignmentId,assignmentVersion: 1,serviceDate: "2026-09-13",idempotencyKey: "reconnect-original-key" };
  mockStore.start.mockResolvedValue({ state: "PENDING",request: original,receipt: null });
  mockApi.startShift.mockRejectedValueOnce(new DevelopmentApiError(0,"OUTCOME_UNKNOWN"));
  mockApi.getShift.mockResolvedValue({ value: { shiftReference,shiftGeneration: generation,resourceVersion: 1,lastActionSequence: 0,lifecycle: "ACTIVE",effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY,precheck: null } });
  const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(surface.getByText("SHIFT_STARTING")).toBeTruthy());
  mockApi.startShift.mockResolvedValue({ value: { outcome: "REPLAYED",shiftReference,shiftGeneration: generation,resourceVersion: 1,effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY } });
  await act(async () => { await observed.recoverUpdates("reconnect"); });
  expect(observed.state.shiftReference).toBe(shiftReference);expect(mockApi.startShift.mock.calls).toEqual([[original],[original]]);
  expect(mockStore.prepareStart).not.toHaveBeenCalled();
});
test("duplicate start taps share one durable command and do not start collection before acceptance", async () => {
  mockLoad.mockResolvedValue(createSyntheticWorkflow());
  mockApi.getItinerary.mockResolvedValue({ value: { serviceDate: "2026-09-14",legs: [{ assignmentId: SYNTHETIC_ENTERPRISE_POLICY.assignmentId,assignmentVersion: 1 }] } });
  const original = { assignmentId: SYNTHETIC_ENTERPRISE_POLICY.assignmentId,assignmentVersion: 1,serviceDate: "2026-09-14",idempotencyKey: "duplicate-original-key" };
  mockStore.prepareStart.mockResolvedValue({ request: original,state: "PENDING" });mockStore.start.mockResolvedValue({ request: original,state: "PENDING",receipt: null });
  let finish: (v: any) => void = () => undefined;mockApi.startShift.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const surface = await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(() => expect(surface.getByText("SIGNED_OUT")).toBeTruthy());
  let first: Promise<any>;let second: Promise<any>;
  await act(async () => { first = observed.startShift();second = observed.startShift(); });
  await waitFor(() => expect(mockApi.startShift).toHaveBeenCalledTimes(1));expect(mockStore.prepareStart).toHaveBeenCalledTimes(1);expect(mockTracking).not.toHaveBeenCalled();
  await act(async () => { finish({ value: { outcome: "APPLIED",shiftReference,shiftGeneration: generation,resourceVersion: 1,effectivePolicy: SYNTHETIC_ENTERPRISE_POLICY } });await Promise.all([first,second]); });
  expect(observed.state.shiftReference).toBe(shiftReference);expect(mockTracking).not.toHaveBeenCalled();
});
test('foreground test timer queues coordinate-free outside-return samples and stops scheduling after server closure',async()=>{
 jest.useFakeTimers();
 try{
  mockLoad.mockResolvedValue({...loaded,shiftReference,phase:'READY',tracking:'TRACKING'});mockPending.mockResolvedValue(null);
  const surface=await render(<WorkflowProvider><Probe /></WorkflowProvider>);
  await waitFor(()=>expect(observed.ready).toBe(true));
  await act(async()=>{await jest.advanceTimersByTimeAsync(20_000);});
  expect(mockFinishStore.prepare).toHaveBeenCalledWith(shiftReference,'LOCATION',{shiftGeneration:generation,samples:[{sampleId:expect.any(String),sequence:1,fixture:'OUTSIDE_RETURN',capturedAt:expect.any(String)}]});
  expect(mockTracking).not.toHaveBeenCalled();
  mockApi.getClosure.mockResolvedValue({value:{shiftReference,shiftGeneration:generation,resourceVersion:4,lifecycle:'SHIFT_ENDED',collectionStopped:true,postcheck:null,lastEvent:'SIGN_OFF',returnResult:'PASS'}});
  await act(async()=>{await observed.syncCloudFinish();});
  const calls=mockFinishStore.prepare.mock.calls.length;
  await act(async()=>{await jest.advanceTimersByTimeAsync(60_000);});
  expect(mockFinishStore.prepare).toHaveBeenCalledTimes(calls);expect(observed.state.phase).toBe('SHIFT_ENDED');
  await surface.unmount();
 }finally{jest.useRealTimers();}
});
