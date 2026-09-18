/**
 * Shifts are named by the part of day they cover, not by an identifier: an operator reads
 * "Driver 042 · Morning shift", never "shift 0ed656ea". The band comes from the assigned
 * run's planned start in the business timezone, so a 09:00 run is Morning even when the
 * driver signs in late.
 */
export type ShiftBand = "Morning" | "Afternoon" | "Evening" | "Night";

export function shiftBandOfDay(startAt: string, timezone: string): ShiftBand {
  const parsed = Date.parse(startAt);
  // An unreadable instant must still name a shift: a card with no title is worse than a
  // conservative one.
  if (!Number.isFinite(parsed)) return "Morning";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(new Date(parsed)));
  if (!Number.isFinite(hour)) return "Morning";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 21) return "Evening";
  return "Night";
}
export function shiftBandLabel(startAt: string, timezone: string): string {
  return `${shiftBandOfDay(startAt, timezone)} shift`;
}
