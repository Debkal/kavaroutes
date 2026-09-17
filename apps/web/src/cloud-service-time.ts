/** Resolve a business-local clock without using the device timezone. Reject
 * nonexistent/ambiguous DST readings instead of silently moving appointments. */
export function resolveLocalServiceStart(serviceDate: string, localTime: string, serviceTimezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new Error("INVALID_SERVICE_DATE");
  if (!/^\d{2}:\d{2}$/.test(localTime)) throw new Error("INVALID_LOCAL_SERVICE_TIME");
  const localClock = Date.parse(`${serviceDate}T${localTime}:00.000Z`);
  if (!Number.isFinite(localClock) || new Date(localClock).toISOString().slice(0,16)!==`${serviceDate}T${localTime}`) throw new Error("INVALID_SERVICE_DATE");
  let formatter: Intl.DateTimeFormat;
  try { formatter=new Intl.DateTimeFormat("en-US",{timeZone:serviceTimezone,timeZoneName:"longOffset",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}); }
  catch { throw new Error("SERVICE_TIMEZONE_UNAVAILABLE"); }
  const offsets=new Set<number>();
  for(const hours of [-36,0,36]) {
    const zone=formatter.formatToParts(new Date(localClock+hours*3600000)).find(part=>part.type==="timeZoneName")?.value;
    if(zone==="GMT") { offsets.add(0); continue; }
    const match=/^GMT([+-])(\d{2}):(\d{2})$/.exec(zone??"");
    if(!match)throw new Error("SERVICE_TIMEZONE_UNAVAILABLE");
    offsets.add((match[1]==="+"?1:-1)*(Number(match[2])*3600+Number(match[3])*60));
  }
  const candidates=[...offsets].map(offsetSeconds=>({instant:new Date(localClock-offsetSeconds*1000).toISOString(),offsetSeconds})).filter(candidate=>{
    const parts=formatter.formatToParts(new Date(candidate.instant));
    const value=(type:string)=>parts.find(part=>part.type===type)!.value;
    return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`===`${serviceDate}T${localTime}`;
  });
  if(candidates.length!==1)throw new Error("This pickup time is skipped or repeated by daylight saving time. Choose another time.");
  return candidates[0]!;
}
