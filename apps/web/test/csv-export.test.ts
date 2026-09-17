import { describe, expect, it } from "vitest";
import { clientDirectoryRows, csvCell, dispatchDayRows } from "../src/csv";

const runs = [
  { runId: "r1", plannedStartAt: "2026-09-17T16:00:00.000Z", plannedEndAt: "2026-09-17T17:00:00.000Z", serviceTimezone: "America/Los_Angeles", assignmentId: "a1", driverId: "d1", vehicleId: "v1" },
  { runId: "r2", plannedStartAt: "2026-09-17T18:00:00.000Z", plannedEndAt: "2026-09-17T19:00:00.000Z", serviceTimezone: "America/Los_Angeles", assignmentId: null, driverId: null, vehicleId: null },
];
const legs = [
  { runId: "r1", riderLabel: "Alex Rider", pickupLabel: "100 Home Way", dropoffLabel: "200 Clinic Way", plannedStartAt: "2026-09-17T16:00:00.000Z", plannedEndAt: "2026-09-17T16:45:00.000Z", appointmentLengthMinutes: 60, lifecycle: "completed" },
  { runId: "r2", riderLabel: "Sam Rider", pickupLabel: "300 Home Way", dropoffLabel: "400 Day Centre", plannedStartAt: "2026-09-17T18:00:00.000Z", plannedEndAt: "2026-09-17T18:30:00.000Z", appointmentLengthMinutes: 30, lifecycle: "dispatched" },
];

describe("spreadsheet export", () => {
  it("never lets operator text become a spreadsheet formula", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe(`"'=SUM(A1:A9)"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell("-1")).toBe(`"'-1"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell('Say "hi"')).toBe(`"Say ""hi"""`);
    expect(csvCell(null)).toBe(`""`);
  });

  it("counts the day's runs, trips and appointment / planned wait minutes", () => {
    const rows = dispatchDayRows({ day: "2026-09-17", runs, legs, drivers: [{ id: "d1", label: "Driver 042" }], vehicles: [{ id: "v1", label: "Van 12" }] });
    const summary = Object.fromEntries(rows.filter(row => row.length === 2 && typeof row[0] === "string" && row[0] !== "KavaRoutes dispatch day")
      .map(row => [String(row[0]), row[1]]));
    expect(summary.Runs).toBe(2);
    expect(summary.Assigned).toBe(1);
    expect(summary["Need a driver"]).toBe(1);
    expect(summary["Trips (legs)"]).toBe(2);
    expect(summary["Total appointment / planned wait minutes"]).toBe(90);
    expect(summary["Average appointment / planned wait minutes"]).toBe(45);
    expect(String(summary["Trips by state"])).toBe("completed: 1; dispatched: 1");
    const header = rows.find(row => row[0] === "Service date");
    expect(header).toEqual(["Service date", "Run", "Client", "Pickup", "Drop-off", "Planned start", "Planned end", "Appointment / planned wait minutes", "State", "Driver", "Vehicle"]);
    const detail = rows.filter(row => row[0] === "2026-09-17");
    expect(detail).toHaveLength(2);
    expect(detail[0]).toContain(60);
    expect(detail[0]).toContain("Driver 042");
    expect(detail[0]).toContain("Van 12");
    expect(detail[1].at(-2)).toBe("");
  });

  it("counts the client directory by drop-off destination and use", () => {
    const rows = clientDirectoryRows([{ displayName: "Alex Rider", entityName: "Sunrise", phone: "555", pickupAddress: "100 Home Way", tripType: "ROUND_TRIP", version: 2,
      dropoffAddresses: [
        { addressLabel: "200 Clinic Way", usageCount: 3, lastUsedAt: "2026-09-10T16:00:00.000Z" },
        { addressLabel: "400 Day Centre", usageCount: 1, lastUsedAt: "2026-09-17T18:00:00.000Z" },
      ] }]);
    expect(rows[0]).toEqual(["KavaRoutes client directory", "1 client(s)"]);
    const row = rows.at(-1)!;
    expect(row[5]).toBe(2);
    expect(row[6]).toBe(4);
    expect(row[7]).toBe("200 Clinic Way");
    expect(row[8]).toBe(3);
    expect(row[9]).toBe("2026-09-17T18:00:00.000Z");
  });

  it("renders a day with no trips without inventing an average", () => {
    const rows = dispatchDayRows({ day: "2026-09-18", runs: [], legs: [], drivers: [], vehicles: [] });
    expect(rows.find(row => row[0] === "Average appointment / planned wait minutes")?.[1]).toBe(0);
    expect(rows.some(row => row[0] === "Trips by state")).toBe(false);
  });
});
