export interface TraceExportFix {readonly latitude:number;readonly longitude:number;readonly capturedAt:string;readonly window?:number}

const coordinate=(fix:TraceExportFix)=>`${fix.latitude.toFixed(5)},${fix.longitude.toFixed(5)}`;

/** A Maps URL gives directions via at most three mobile-safe waypoints. Google
 * recalculates roads, so this is deliberately not called an exact GPS export. */
export function googleMapsRouteUrl(points:readonly TraceExportFix[]):string|null{
  if(!points.length)return null;
  if(points.length===1){const url=new URL('https://www.google.com/maps/search/');url.searchParams.set('api','1');url.searchParams.set('query',coordinate(points[0]!));return url.href;}
  const url=new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api','1');url.searchParams.set('origin',coordinate(points[0]!));
  url.searchParams.set('destination',coordinate(points.at(-1)!));url.searchParams.set('travelmode','driving');
  const middle=[.25,.5,.75].map(part=>Math.min(points.length-2,Math.max(1,Math.round((points.length-1)*part))));
  const waypoints=[...new Set(middle)].map(index=>coordinate(points[index]!));
  if(waypoints.length)url.searchParams.set('waypoints',waypoints.join('|'));
  return url.href;
}

export function traceKml(day:string,points:readonly TraceExportFix[]):string{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!points.length||points.length>500||points.some(point=>!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude)||Math.abs(point.latitude)>90||Math.abs(point.longitude)>180||!Number.isFinite(Date.parse(point.capturedAt))))throw new Error('INVALID_TRACE_EXPORT');
  const segments:TraceExportFix[][]=[];
  for(const point of points){const previous=segments.at(-1)?.at(-1);
    if(!previous||Date.parse(point.capturedAt)-Date.parse(previous.capturedAt)>90_000||point.window!==previous.window)segments.push([]);
    segments.at(-1)!.push(point);
  }
  const xml=(point:TraceExportFix)=>`${point.longitude.toFixed(6)},${point.latitude.toFixed(6)},0`;
  const lines=segments.filter(segment=>segment.length>1).map((segment,index)=>`<Placemark><name>Observed segment ${index+1}</name><styleUrl>#recorded</styleUrl><LineString><tessellate>1</tessellate><coordinates>${segment.map(xml).join(' ')}</coordinates></LineString></Placemark>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>KavaRoutes recorded GPS ${day}</name><Style id="recorded"><LineStyle><color>ff7c6317</color><width>5</width></LineStyle></Style>${lines}<Placemark><name>First saved fix</name><Point><coordinates>${xml(points[0]!)}</coordinates></Point></Placemark><Placemark><name>Last saved fix</name><Point><coordinates>${xml(points.at(-1)!)}</coordinates></Point></Placemark></Document></kml>`;
}

export function downloadTraceKml(filename:string,body:string):void{
  const url=URL.createObjectURL(new Blob([body],{type:'application/vnd.google-earth.kml+xml;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();URL.revokeObjectURL(url);
}
