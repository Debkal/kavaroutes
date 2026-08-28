import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import ProposalScreen from "../app/proposal";
import ShiftHomeScreen from "../app/index";

const mockUseWorkflow = jest.fn();
jest.mock("@kavaroutes/driver-core", () => ({ actionLabel: (step: string) => step.replaceAll("_", " ") }));
jest.mock("../src/workflow-context", () => ({ useWorkflow: () => mockUseWorkflow() }));
test("status is exposed through text and an accessible summary", async () => {
  const surface = await render(<StatusCard title="Tracking" status="STOPPED BY DRIVER" />);
  expect(surface.getByRole("summary", { name: "Tracking: STOPPED BY DRIVER" })).toBeTruthy();
  expect(surface.getByText("STOPPED BY DRIVER")).toBeTruthy();
});

test("primary actions execute and guard duplicate activation while busy", async () => {
  let releases = () => undefined;
  const action = jest.fn(() => new Promise<void>((resolve) => { releases = resolve; }));
  const surface = await render(<PrimaryButton label="Do synthetic work" busyLabel="Working" onPress={action} />);
  fireEvent.press(surface.getByRole("button", { name: "Do synthetic work" }));
  await waitFor(() => expect(surface.getByRole("button", { name: "Working" })).toBeDisabled());
  fireEvent.press(surface.getByRole("button", { name: "Working" }));
  expect(action).toHaveBeenCalledTimes(1);
  releases();
  await waitFor(() => expect(surface.getByRole("button", { name: "Do synthetic work" })).toBeEnabled());
});

test("route proposal surface displays server policy without client tier or approval controls", async () => {
  mockUseWorkflow.mockReturnValue({ dispatch: jest.fn(), state: { moving: false, proposalState: "NONE", effectivePolicy: {
    commercialTier: "SMALL_BUSINESS", workforceRelationship: "OWNER_OPERATOR", policyVersion: 3, canonicalDigest: "a".repeat(64),
    routeChange: { mode: "AUTHORIZED_SELF_APPROVE" },
  } } });
  const surface = await render(<ProposalScreen />);
  expect(surface.getByText("The accepted policy permits validated self-approval for this assigned principal.")).toBeTruthy();
  expect(surface.queryByRole("button", { name: /enterprise|small business|dispatch approves|dispatch rejects/i })).toBeNull();
});

test("route proposal surface omits proposal actions when the pinned policy disables them", async () => {
  mockUseWorkflow.mockReturnValue({ dispatch: jest.fn(), state: { moving: false, proposalState: "NONE", effectivePolicy: {
    commercialTier: "ENTERPRISE", workforceRelationship: "EMPLOYEE", policyVersion: 4, canonicalDigest: "b".repeat(64),
    routeChange: { mode: "DISABLED" },
  } } });
  const surface = await render(<ProposalScreen />);
  expect(surface.getByText("Route changes unavailable")).toBeTruthy();
  expect(surface.queryByRole("button", { name: /route draft|future-stop reorder/i })).toBeNull();
});

test("small business home offers one clear start action without policy internals", async () => {
  const dispatch = jest.fn(async () => ({ phase: "READY" }));
  mockUseWorkflow.mockReturnValue({ dispatch, ready: true, error: undefined, startShift: jest.fn(), state: {
    phase: "PRECHECK_OFFERED", moving: false, effectivePolicy: { commercialTier: "SMALL_BUSINESS" },
  } });
  const surface = await render(<ShiftHomeScreen />);
  fireEvent.press(surface.getByRole("button", { name: "Confirm van and start route" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "SKIP_PRECHECK", reason: "OPTIONAL_CONTROL_SKIPPED" }));
  expect(surface.getByText("Ready to start your route?")).toBeTruthy();
  expect(surface.queryByText(/policy v|canonical|digest/i)).toBeNull();
});
