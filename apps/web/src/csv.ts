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

export interface EstimateExportRow { readonly label: string; readonly serviceDate: string; readonly plannedStartAt: string;
  readonly miles: number; readonly minutes: number; readonly totalCents: number; readonly costPerMileCents: number;
  readonly suggestedPriceCents: number; readonly contractedPriceCents: number; readonly marginAtContractedPercent: number;
  readonly marginAdvice: string }

/** The costing sheet: one row per trip, counted by day, so the margin advice travels with
 * the numbers it came from. */
export function estimateRows(input: { readonly day: string; readonly rows: readonly EstimateExportRow[];
  readonly tripsPerMonth?: number;
  readonly profile: { readonly fuelCentsPerGallon: number; readonly fuelEfficiencyMpg: number; readonly maintenanceCentsPerMile: number;
    readonly vehicleCount?: number; readonly expectedMonthlyTrips?: number; readonly annualFixedCostsCents?: number;
    readonly includedBusinessInsurance?: readonly string[];
    readonly workersCompAnnualCents?: number;
    readonly generalLiabilityAnnualCents?: number;
    readonly umbrellaAnnualCents?: number;
    readonly professionalLiabilityAnnualCents?: number;
    readonly cyberInsuranceAnnualCents?: number;
    readonly otherInsuranceAnnualCents?: number;
    readonly driverHourlyCents: number; readonly driverBurdenPercent: number; readonly insuranceCentsPerMonthPerVehicle: number;
    readonly fixedOverheadCentsPerMonth: number; readonly deadheadPercent: number; readonly targetMarginPercent: number;
    readonly contractedBaseCents: number; readonly contractedCentsPerMile: number } }): CsvRow[] {
  const { day, rows, profile } = input;
  const totalCost = rows.reduce((sum, row) => sum + row.totalCents, 0);
  const totalSuggested = rows.reduce((sum, row) => sum + row.suggestedPriceCents, 0);
  const totalContracted = rows.reduce((sum, row) => sum + row.contractedPriceCents, 0);
  const totalMiles = rows.reduce((sum, row) => sum + row.miles, 0);
  return [
    ["KavaRoutes route estimates", day],
    ["Fleet rides/month used",input.tripsPerMonth??167],
    ["Vehicles",profile.vehicleCount??1],
    ["Expected fleet rides/month",profile.expectedMonthlyTrips??167],
    ["Additional annual fixed costs cents",profile.annualFixedCostsCents??0],
    ["Included business insurance",profile.includedBusinessInsurance?.join("; ")??"All entered premiums (legacy profile)"],
    ["Workers’ compensation annual cents",profile.workersCompAnnualCents??0],
    ["General liability annual cents",profile.generalLiabilityAnnualCents??0],
    ["Umbrella / excess liability annual cents",profile.umbrellaAnnualCents??0],
    ["Professional liability annual cents",profile.professionalLiabilityAnnualCents??0],
    ["Cyber insurance annual cents",profile.cyberInsuranceAnnualCents??0],
    ["Other business insurance annual cents",profile.otherInsuranceAnnualCents??0],
    ["Fuel cents per gallon", profile.fuelCentsPerGallon],
    ["Fuel efficiency (mpg)", profile.fuelEfficiencyMpg],
    ["Maintenance cents per mile", profile.maintenanceCentsPerMile],
    ["Driver hourly cents", profile.driverHourlyCents],
    ["Driver burden percent", profile.driverBurdenPercent],
    ["Insurance cents per month per vehicle", profile.insuranceCentsPerMonthPerVehicle],
    ["Fixed overhead cents per month", profile.fixedOverheadCentsPerMonth],
    ["Deadhead percent", profile.deadheadPercent],
    ["Target margin percent", profile.targetMarginPercent],
    ["Contracted base cents", profile.contractedBaseCents],
    ["Contracted cents per mile", profile.contractedCentsPerMile],
    ["Trips", rows.length],
    ["Total miles", Math.round(totalMiles * 100) / 100],
    ["Total cost cents", totalCost],
    ["Total suggested price cents", totalSuggested],
    ["Total contracted cents", totalContracted],
    ["Total margin at contracted cents", totalContracted - totalCost],
    ["Average margin at contracted percent", totalContracted > 0 ? Math.round(((totalContracted - totalCost) / totalContracted) * 1000) / 10 : 0],
    [],
    ["Trip", "Service date", "Planned start", "Miles", "Minutes", "Cost cents", "Cost per mile cents", "Suggested price cents",
      "Contracted cents", "Margin at contracted percent", "Margin advice"],
    ...rows.map(row => [row.label, row.serviceDate, row.plannedStartAt, row.miles, row.minutes, row.totalCents,
      row.costPerMileCents, row.suggestedPriceCents, row.contractedPriceCents, row.marginAtContractedPercent, row.marginAdvice]),
  ];
}

export interface InvoiceExportLine { readonly ordinal: number; readonly serviceDate: string; readonly description: string;
  readonly miles: number; readonly hcpcsCode: string | null; readonly authorizationNumber: string | null;
  readonly proofOfService: string; readonly amountCents: number }
export interface InvoiceExport { readonly invoiceId: string; readonly clientLabel: string | null; readonly payerKind: string;
  readonly payerName: string; readonly claimReference: string | null; readonly periodStart: string; readonly periodEnd: string;
  readonly status: string; readonly totalCents: number; readonly totalMiles: number; readonly forwardedAt: string | null;
  readonly forwardedMethod: string | null; readonly forwardedTo: string | null; readonly lines: readonly InvoiceExportLine[] }

/** The claim packet: header fields a payer asks for, then one line per billed trip with
 * its HCPCS code, authorization number and proof of service. */
export function invoiceClaimRows(invoice: InvoiceExport): CsvRow[] {
  const lineAmounts = invoice.lines.map(line => line.amountCents);
  const unitCharges = new Set(lineAmounts);
  return [
    ["KavaRoutes claim packet", invoice.invoiceId],
    ["Payer kind", invoice.payerKind], ["Payer", invoice.payerName],
    ["Client", invoice.clientLabel ?? ""], ["Claim reference", invoice.claimReference ?? ""],
    ["Period", `${invoice.periodStart} to ${invoice.periodEnd}`], ["Invoice status", invoice.status],
    ["Total charge cents", invoice.totalCents], ["Total miles", invoice.totalMiles],
    ["Billed trips", invoice.lines.length],
    ["Forwarded", invoice.forwardedAt ? `${invoice.forwardedMethod ?? ""} → ${invoice.forwardedTo ?? ""} at ${invoice.forwardedAt}` : "Not forwarded"],
    [],
    ["Line", "Service date", "Description", "Miles", "HCPCS", "Authorization", "Proof of service", "Charge cents"],
    ...invoice.lines.map(line => [line.ordinal, line.serviceDate, line.description, line.miles, line.hcpcsCode ?? "",
      line.authorizationNumber ?? "", line.proofOfService, line.amountCents]),
    [],
    ["Summary", "Trips", invoice.lines.length, "Unique line charges", unitCharges.size],
  ];
}

export interface ClientHistoryExportTrip { readonly serviceDate: string; readonly pickupLabel: string | null; readonly dropoffLabel: string | null;
  readonly plannedStartAt: string; readonly appointmentLengthMinutes: number; readonly tripState: string; readonly executionState: string;
  readonly driverLabel: string | null; readonly measuredMiles: number | null; readonly proofCount: number }
export function clientHistoryRows(input: { readonly clientLabel: string; readonly days: number;
  readonly trips: readonly ClientHistoryExportTrip[];
  readonly totals: { readonly trips: number; readonly delivered: number; readonly cancelled: number; readonly measuredMiles: number;
    readonly appointmentMinutes: number; readonly tripsWithProof: number } }): CsvRow[] {
  return [
    ["KavaRoutes client route history", input.clientLabel],
    ["Lookback days", input.days],
    ["Trips", input.totals.trips], ["Delivered", input.totals.delivered], ["Cancelled", input.totals.cancelled],
    ["Measured miles (delivered)", input.totals.measuredMiles], ["Appointment / wait minutes", input.totals.appointmentMinutes],
    ["Delivered trips with proof", input.totals.tripsWithProof],
    [],
    ["Service date", "Planned start", "Pickup", "Drop-off", "Appointment minutes", "Trip state", "Execution state", "Driver", "Measured miles", "Proofs"],
    ...input.trips.map(trip => [trip.serviceDate, trip.plannedStartAt, trip.pickupLabel ?? "", trip.dropoffLabel ?? "",
      trip.appointmentLengthMinutes, trip.tripState, trip.executionState, trip.driverLabel ?? "",
      trip.measuredMiles === null ? "" : trip.measuredMiles, trip.proofCount]),
  ];
}
