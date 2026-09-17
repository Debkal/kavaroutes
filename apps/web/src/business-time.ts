// Deployment-owned settings for the current single-business prototype.
// Never infer the business timezone from the dispatcher's device location.
export const businessTimezone: string = import.meta.env.VITE_KAVAROUTES_BUSINESS_TIMEZONE || "America/Los_Angeles";
new Intl.DateTimeFormat("en-US", {timeZone: businessTimezone}).format();
export const businessTimezoneLabel = businessTimezone.replaceAll("_", " ");

export function businessToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone: businessTimezone, year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function shiftServiceDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function serviceDayLabel(day: string): string {
  return new Intl.DateTimeFormat(undefined, {timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric"}).format(new Date(`${day}T12:00:00Z`));
}
export function businessTime(instant: string): string {
  return new Intl.DateTimeFormat(undefined, {timeZone: businessTimezone, hour: "numeric", minute: "2-digit", timeZoneName: "short"}).format(new Date(instant));
}
