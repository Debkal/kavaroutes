import { fireEvent, render, waitFor } from "@testing-library/react-native";
import InspectionScreen from "../app/inspection";
import { INSPECTION_ITEMS, SYNTHETIC_ENTERPRISE_POLICY, createSyntheticWorkflow } from "../../../packages/driver-core/src/workflow";
import { readInspectionFormDraft, saveInspectionFormDraft } from "../src/nativeActions";

const mockUseWorkflow = jest.fn();
const mockReplace = jest.fn();
const mockSaveEvidence = jest.fn();
jest.mock("@kavaroutes/driver-core", () => jest.requireActual("../../../packages/driver-core/src/workflow"));
jest.mock("../src/workflow-context", () => ({ useWorkflow: () => mockUseWorkflow() }));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("expo-camera", () => ({ CameraView: "CameraView", useCameraPermissions: () => [{ granted: true }, jest.fn()] }));
jest.mock("expo-file-system", () => ({ File: jest.fn() }));
jest.mock("../src/nativeActions", () => ({ queueSyntheticEvidence: jest.fn(), saveSyntheticDefectPhoto: jest.fn(),
  saveSyntheticEvidence: (...args: unknown[]) => mockSaveEvidence(...args), supersedeSyntheticDefectPhoto: jest.fn(),
  readInspectionFormDraft: jest.fn(async () => null), saveInspectionFormDraft: jest.fn(async () => undefined) }));

function context(inspection = "REQUIRED", odometer = "REQUIRED") {
  const dispatch = jest.fn(async () => undefined);
  const state = { ...createSyntheticWorkflow(), phase: "PRECHECK_REQUIRED", vehicleConfirmed: true,
    effectivePolicy: { ...SYNTHETIC_ENTERPRISE_POLICY, preInspection: { mode: inspection }, startOdometer: { mode: odometer } },
    preCheck: Object.fromEntries(INSPECTION_ITEMS.map(item => [item, { response: "NO_DEFECT" }])) };
  mockUseWorkflow.mockReturnValue({ state, dispatch, cloudPrototype: true, itinerary: { legs: [] } });
  return dispatch;
}
beforeEach(() => { jest.clearAllMocks(); });
test("unfinished numeric input, note, photo selection and optional decisions reopen from the protected draft", async () => {
  context("OPTIONAL", "OPTIONAL");
  const draft = { index: 2, odometer: "1042", fuel: "HALF", defect: true, severity: "MINOR", note: "Unfinished synthetic note",
    skipInspection: false, skipOdometer: true, photoDigest: "b".repeat(64), photoException: null };
  jest.mocked(readInspectionFormDraft).mockResolvedValueOnce(draft as any);
  const surface = await render(<InspectionScreen />);
  await waitFor(() => expect(surface.getByDisplayValue("Unfinished synthetic note")).toBeTruthy());
  expect(surface.getByRole("button", { name: "Retake synthetic defect photo" })).toBeTruthy();
  expect(surface.getByText("Optional skip selected — not accepted yet")).toBeTruthy();
  await fireEvent.changeText(surface.getByLabelText("Defect note"), "Corrected synthetic note");
  await waitFor(() => expect(saveInspectionFormDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ odometer: "1042", note: "Corrected synthetic note", photoDigest: draft.photoDigest })));
});

test("private-cloud form accepts a numeric odometer and waits for the command, without synthetic evidence acceptance", async () => {
  const dispatch = context(); const surface = await render(<InspectionScreen />);
  await waitFor(() => expect(surface.getByLabelText("Starting odometer")).toBeTruthy());
  await fireEvent.changeText(surface.getByLabelText("Starting odometer"), "10420");
  await fireEvent.press(surface.getByRole("button", { name: "Complete pre-trip check" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "COMPLETE_PRECHECK", odometer: 10420, fuelLevel: "FULL" }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/"));
  expect(mockSaveEvidence).not.toHaveBeenCalled();
});

test("optional checklist can be skipped while required odometer is completed", async () => {
  const dispatch = context("OPTIONAL", "REQUIRED"); const surface = await render(<InspectionScreen />);
  await waitFor(() => expect(surface.getByLabelText("Starting odometer")).toBeTruthy());
  await fireEvent.press(surface.getByRole("button", { name: "Skip optional checklist only" }));
  await fireEvent.changeText(surface.getByLabelText("Starting odometer"), "10421");
  await fireEvent.press(surface.getByRole("button", { name: "Complete pre-trip check" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "COMPLETE_PRECHECK", odometer: 10421, fuelLevel: "FULL",
    skip: ["INSPECTION"], reason: "OPTIONAL_CONTROL_SKIPPED" }));
});

test("invalid input and critical defect do not expose a ready route", async () => {
  const dispatch = context(); const surface = await render(<InspectionScreen />);
  await waitFor(() => expect(surface.getByLabelText("Starting odometer")).toBeTruthy());
  await fireEvent.changeText(surface.getByLabelText("Starting odometer"), "12.5");
  await fireEvent.press(surface.getByRole("button", { name: "Complete pre-trip check" }));
  await waitFor(() => expect(surface.getByText("Enter a whole odometer reading from 0 to 9,999,999")).toBeTruthy());
  expect(dispatch).not.toHaveBeenCalled();
  await surface.unmount();
  mockUseWorkflow.mockReturnValue({ state: { ...createSyntheticWorkflow(), phase: "BLOCKED_CRITICAL_DEFECT", lastReceipt: "Server block" }, cloudPrototype: true });
  const blocked = await render(<InspectionScreen />);
  await waitFor(() => expect(blocked.getByText("Vehicle out of service")).toBeTruthy());
  expect(blocked.queryByRole("button", { name: /complete|continue|override/i })).toBeNull();
});
