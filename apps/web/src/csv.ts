/**
 * The one place dispatch data becomes a spreadsheet. A workbook an operator opens in
 * Excel must carry both the detail rows and the counts an appointment/wait report needs,
 * and operator-entered text must never be read as a formula, so every cell goes through
 * `csvCell`.
 */

export type CsvCell = string | number | null | undefined;
export type CsvRow = readonly CsvCell[];

/** One cell. A leading =, +, - or @ is prefixed with an apostrophe so a spreadsheet
 * treats operator-entered text as text rather than as a formula. */
export function csvCell(value: CsvCell): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function csvBody(rows: readonly CsvRow[]): string {
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, rows: readonly CsvRow[]): void {
  const blob = new Blob([csvBody(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

export interface DispatchExportRun { readonly runId: string; readonly plannedStartAt: string; readonly plannedEndAt: string;
  readonly serviceTimezone: string; readonly assignmentId: string | null; readonly driverId: string | null; readonly vehicleId: string | null }
export interface DispatchExportLeg { readonly runId: string; readonly riderLabel: string; readonly pickupLabel: string; readonly dropoffLabel: string;
  readonly plannedStartAt: string; readonly plannedEndAt: string; readonly appointmentLengthMinutes?: number; readonly lifecycle: string }
export interface DispatchExportResource { readonly id: string; readonly label: string }

/** The planned wait ("appointment length") is the number dispatch enters per trip; the
 * report counts it per day and per trip so waiting time can be reconciled later. */
export function dispatchDayRows(input: { readonly day: string; readonly runs: readonly DispatchExportRun[];
  readonly legs: readonly DispatchExportLeg[]; readonly drivers: readonly DispatchExportResource[]; readonly vehicles: readonly DispatchExportResource[] }): CsvRow[] {
  const { day, runs, legs, drivers, vehicles } = input;
  const assigned = runs.filter(run => run.assignmentId).length;
  const waits = legs.map(leg => Number(leg.appointmentLengthMinutes ?? 0));
  const totalWait = waits.reduce((sum, value) => sum + value, 0);
  const states = new Map<string, number>();
  for (const leg of legs) states.set(leg.lifecycle, (states.get(leg.lifecycle) ?? 0) + 1);
  const label = (list: readonly DispatchExportResource[], id: string | null) => list.find(item => item.id === id)?.label ?? "";
  const summary: CsvRow[] = [
    ["KavaRoutes dispatch day", day],
    ["Runs", runs.length],
    ["Assigned", assigned],
    ["Need a driver", runs.length - assigned],
    ["Trips (legs)", legs.length],
    ["Total appointment / planned wait minutes", totalWait],
    ["Average appointment / planned wait minutes", legs.length ? Math.round((totalWait / legs.length) * 10) / 10 : 0],
    ...(states.size ? [["Trips by state", [...states.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([state, count]) => `${state}: ${count}`).join("; ")]] : []),
  ];
  const detail: CsvRow[] = [
    [],
    ["Service date", "Run", "Client", "Pickup", "Drop-off", "Planned start", "Planned end", "Appointment / planned wait minutes", "State", "Driver", "Vehicle"],
    ...legs.map(leg => {
      const parent = runs.find(run => run.runId === leg.runId);
      return [day, leg.runId, leg.riderLabel, leg.pickupLabel, leg.dropoffLabel, leg.plannedStartAt, leg.plannedEndAt,
        Number(leg.appointmentLengthMinutes ?? 0), leg.lifecycle, label(drivers, parent?.driverId ?? null), label(vehicles, parent?.vehicleId ?? null)];
    }),
  ];
  return [...summary, ...detail];
}

export interface ClientExportDropoff { readonly addressLabel: string; readonly usageCount: number; readonly lastUsedAt: string | null }
export interface ClientExportRecord { readonly displayName: string; readonly entityName: string | null; readonly phone: string | null;
  readonly pickupAddress: string | null; readonly tripType: string | null; readonly version: number;
  readonly dropoffAddresses: readonly ClientExportDropoff[] }

/** The client directory counted: how many destinations each client has, how often each
 * has been scheduled, and the most recent and most frequent one. */
export function clientDirectoryRows(clients: readonly ClientExportRecord[]): CsvRow[] {
  const mostUsed = (dropoffs: readonly ClientExportDropoff[]) => [...dropoffs].sort((a, b) =>
    b.usageCount - a.usageCount || Date.parse(b.lastUsedAt ?? "1970-01-01") - Date.parse(a.lastUsedAt ?? "1970-01-01") || a.addressLabel.localeCompare(b.addressLabel))[0];
  return [
    ["KavaRoutes client directory", `${clients.length} client(s)`],
    [],
    ["Client", "Entity", "Phone", "Pickup address", "Trip type", "Recorded drop-offs", "Total drop-off uses", "Most used drop-off", "Most used drop-off uses", "Last used drop-off at"],
    ...clients.map(client => {
      const totalUses = client.dropoffAddresses.reduce((sum, dropoff) => sum + Number(dropoff.usageCount ?? 0), 0);
      const top = mostUsed(client.dropoffAddresses);
      const lastUsed = client.dropoffAddresses.map(dropoff => dropoff.lastUsedAt).filter((value): value is string => typeof value === "string")
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? "";
      return [client.displayName, client.entityName ?? "", client.phone ?? "", client.pickupAddress ?? "", client.tripType ?? "",
        client.dropoffAddresses.length, totalUses, top?.addressLabel ?? "", top?.usageCount ?? 0, lastUsed];
    }),
  ];
}
