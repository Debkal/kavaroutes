import { fireEvent, render,waitFor } from "@testing-library/react-native";
import { CloudStopDetails } from "../src/components/CloudStopDetails";
import type { DriverItinerary } from "@kavaroutes/api-contracts/client-web";

const leg = { assignmentId: "40000000-0000-4000-8000-000000000001", assignmentVersion: 1,
  runId: "40000000-0000-4000-8000-000000000002", runVersion: 1, runLifecycle: "scheduled",
  tripId: "40000000-0000-4000-8000-000000000003", tripLegId: "40000000-0000-4000-8000-000000000004",
  ordinal: 1, vehicleId: null, vehicleLabel: "Assigned synthetic van", riderLabel: "Assigned synthetic rider",
  pickupLabel: "Cloud pickup", dropoffLabel: "Cloud drop-off", plannedStartAt: "2026-09-13T16:00:00.000Z",
  plannedEndAt: "2026-09-13T17:00:00.000Z", serviceTimezone: "America/Los_Angeles" };
const itinerary: DriverItinerary = { driverReference: "30000000-0000-4000-8000-000000000001", serviceDate: "2026-09-13", legs: [leg] };
test("connected pickup controls send the actual assigned leg and expose failure without changing its status", async () => {
  const action = jest.fn(async () => { throw new Error("OUTCOME_UNKNOWN"); });
  const screen = await render(<CloudStopDetails reference={leg.tripLegId} moving={false} action={action} itinerary={{ ...itinerary,legs: [{ ...leg,
    execution: { executionId: "50000000-0000-4000-8000-000000000003",lifecycle: "DISPATCHED",version: 1,expectedTag: '"kr1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' } }] }} />);
  await fireEvent.press(screen.getByRole("button",{ name: "Start pickup route" }));
  await waitFor(() => expect(action).toHaveBeenCalledWith(leg.tripLegId,"MARK_EN_ROUTE"));
  expect(screen.getByText("OUTCOME UNKNOWN")).toBeTruthy();expect(screen.getByText("DISPATCHED")).toBeTruthy();
});

test("cloud stop details use the authorized itinerary instead of synthetic screen fixtures", async () => {
  const screen = await render(<CloudStopDetails reference={leg.tripLegId} itinerary={itinerary} moving={false} />);
  expect(screen.getByText("Cloud pickup")).toBeTruthy();
  expect(screen.getByText("Cloud drop-off")).toBeTruthy();
  expect(screen.getByText("Assigned synthetic rider")).toBeTruthy();
  expect(screen.queryByText("Synthetic Rider A")).toBeNull();
});

test("unassigned and moving views do not reveal stop details", async () => {
  const absent = await render(<CloudStopDetails reference="unknown" itinerary={itinerary} moving={false} />);
  expect(absent.queryByText("Cloud pickup")).toBeNull();
  const moving = await render(<CloudStopDetails reference={leg.tripLegId} itinerary={itinerary} moving />);
  expect(moving.queryByText("Cloud pickup")).toBeNull();
});

test("cloud stop renders server execution separately from assignment and handles rollout absence", async () => {
  const screen = await render(<CloudStopDetails reference={leg.tripLegId} itinerary={itinerary} moving={false} />);
  expect(screen.getByText("Execution not available")).toBeTruthy();
  await screen.rerender(<CloudStopDetails reference={leg.tripLegId} moving={false} itinerary={{ ...itinerary,
    legs: [{ ...leg, execution: { executionId: "50000000-0000-4000-8000-000000000003", lifecycle: "EN_ROUTE_PICKUP", version: 2 } }] }} />);
  expect(screen.getByText("EN ROUTE PICKUP")).toBeTruthy();
  expect(screen.getByText("Recorded version 2")).toBeTruthy();
});
