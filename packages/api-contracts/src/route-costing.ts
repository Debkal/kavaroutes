/**
 * Route costing: what a trip costs us, and what it must be charged for the operation to
 * stay viable. The arithmetic is pure so the server and the board's live preview cannot
 * disagree, and every default below is a research range an operator replaces with their
 * own quotes.
 *
 * Sources behind the defaults (checked 2026-09-17):
 * - Fuel: US average regular $4.07–$4.37/gal (EIA weekly 2026-08-31 $4.071; AAA 2026-09-16
 *   $4.367; West Coast $5.21–5.36, California $5.52–6.02). A NEMT van runs 12–16 mpg.
 * - Maintenance: $0.12–$0.18 per mile for a preventive programme; WAV lift/ramp servicing
 *   adds $2,000–$4,000 a year.
 * - Driver: $14–$18/hr ambulatory, $18–$25/hr wheelchair/stretcher, with 25–40% burden for
 *   taxes, workers' comp and benefits.
 * - Insurance: ambulatory $350–$625/month, WAV $565–$1,165/month, stretcher $750–$1,500;
 *   year-one all-in per vehicle $1,250–$2,583/month once GL, excess and workers' comp are
 *   counted. General liability $2,000–$3,500/year and an excess/umbrella layer
 *   $1,500–$4,500/year for the company.
 * - Trips per vehicle: 6–10 a day over ~250 days → roughly 150–220 trips a month.
 * - Margins: broker-reimbursed work nets 8–15%, private-pay and facility work 20–35%, a
 *   blended operation 12–22% (year one 5–10%). A broker trip below an 8% margin is not
 *   worth running; private-pay work below ~20% leaves nothing for the next vehicle.
 */

export interface RouteCostProfile {
  readonly fuelCentsPerGallon: number;
  readonly fuelEfficiencyMpg: number;
  readonly maintenanceCentsPerMile: number;
  readonly driverHourlyCents: number;
  readonly driverBurdenPercent: number;
  readonly insuranceCentsPerMonthPerVehicle: number;
  readonly fixedOverheadCentsPerMonth: number;
  readonly deadheadPercent: number;
  readonly targetMarginPercent: number;
  readonly contractedBaseCents: number;
  readonly contractedCentsPerMile: number;
  readonly averageTripMiles: number;
  readonly loadedMilesPerHour: number;
}

export const routeCostProfileDefaults: RouteCostProfile = Object.freeze({
  fuelCentsPerGallon: 416, fuelEfficiencyMpg: 14, maintenanceCentsPerMile: 15,
  driverHourlyCents: 1800, driverBurdenPercent: 30,
  insuranceCentsPerMonthPerVehicle: 100000, fixedOverheadCentsPerMonth: 80000,
  deadheadPercent: 15, targetMarginPercent: 18,
  contractedBaseCents: 4500, contractedCentsPerMile: 250,
  averageTripMiles: 12, loadedMilesPerHour: 20,
});

/** The two floors the research supports: broker work under 8% loses money once an empty
 * leg or a no-show lands, and private-pay/facility work below 20% cannot fund the next
 * vehicle. */
export const brokerMarginFloorPercent = 8;
export const privatePayTargetPercent = 20;

export interface RouteEstimateInput {
  /** Loaded miles for the trip; the caller substitutes the profile average when unknown. */
  readonly miles: number;
  /** Door-to-door minutes including the appointment/wait the dispatcher recorded. */
  readonly tripMinutes: number;
  /** Trips this vehicle runs in a month, for spreading fixed costs. */
  readonly tripsPerMonth: number;
}

export interface RouteEstimate {
  readonly miles: number;
  readonly fuelCents: number;
  readonly maintenanceCents: number;
  readonly driverCents: number;
  readonly insuranceCents: number;
  readonly overheadCents: number;
  readonly totalCents: number;
  readonly costPerMileCents: number;
  readonly suggestedPriceCents: number;
  readonly contractedPriceCents: number;
  readonly marginAtContractedCents: number;
  readonly marginAtContractedPercent: number;
  readonly meetsTarget: boolean;
  readonly marginAdvice: string;
}

const round = (value: number) => Math.round(value);

export function estimateRouteCost(profile: RouteCostProfile, input: RouteEstimateInput): RouteEstimate {
  const miles = Math.max(0, input.miles);
  const tripsPerMonth = Math.max(1, Math.round(input.tripsPerMonth));
  const deadheadFactor = 1 + Math.max(0, profile.deadheadPercent) / 100;
  const billedMiles = miles * deadheadFactor;
  const fuelCents = round((billedMiles / Math.max(0.1, profile.fuelEfficiencyMpg)) * profile.fuelCentsPerGallon);
  const maintenanceCents = round(billedMiles * profile.maintenanceCentsPerMile);
  const driverCents = round((Math.max(0, input.tripMinutes) / 60) * profile.driverHourlyCents * (1 + profile.driverBurdenPercent / 100));
  const insuranceCents = round(profile.insuranceCentsPerMonthPerVehicle / tripsPerMonth);
  const overheadCents = round(profile.fixedOverheadCentsPerMonth / tripsPerMonth);
  const totalCents = fuelCents + maintenanceCents + driverCents + insuranceCents + overheadCents;
  const target = Math.min(90, Math.max(0, profile.targetMarginPercent)) / 100;
  const suggestedPriceCents = target >= 1 ? totalCents : round(totalCents / (1 - target));
  const contractedPriceCents = round(profile.contractedBaseCents + profile.contractedCentsPerMile * miles);
  const marginAtContractedCents = contractedPriceCents - totalCents;
  const marginAtContractedPercent = contractedPriceCents > 0 ? round((marginAtContractedCents / contractedPriceCents) * 1000) / 10 : 0;
  const meetsTarget = marginAtContractedPercent >= profile.targetMarginPercent;
  // The advice follows the two floors the research supports rather than one target: a
  // broker trip and a private-pay trip have different break-even points.
  const marginAdvice = contractedPriceCents <= 0
    ? "Enter the contracted base and per-mile rate to see the margin this trip really earns."
    : marginAtContractedPercent < brokerMarginFloorPercent
      ? `Below the ${brokerMarginFloorPercent}% floor: this trip loses money once an empty leg or a no-show lands. Negotiate, restructure, or decline it.`
      : meetsTarget
        ? "At or above the margin target you set for this work."
        : marginAtContractedPercent >= privatePayTargetPercent
          ? `Profitable private-pay work (at or above ${privatePayTargetPercent}%), below the margin target you set.`
          : `Broker-viable (at or above ${brokerMarginFloorPercent}%) but below the ${privatePayTargetPercent}% private-pay target; it cannot fund the next vehicle on its own.`;
  return { miles, fuelCents, maintenanceCents, driverCents, insuranceCents, overheadCents, totalCents,
    costPerMileCents: miles > 0 ? round(totalCents / miles) : 0, suggestedPriceCents, contractedPriceCents,
    marginAtContractedCents, marginAtContractedPercent, meetsTarget, marginAdvice };
}

/** The default trips a vehicle runs a month, from 8 trips a day over 250 working days. */
export const defaultTripsPerMonth = 167;
