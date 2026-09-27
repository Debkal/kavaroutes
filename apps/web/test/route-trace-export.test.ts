import {expect,it} from 'vitest';
import {fitTraceView,panTraceView,zoomTraceView} from '../src/route-map-view';
import {googleMapsRouteUrl,traceKml} from '../src/route-trace-export';

const day='2026-09-25';
const points=[0,30,180,210].map((seconds,index)=>({latitude:41.88+index*.001,longitude:-87.62-index*.001,
  capturedAt:new Date(Date.parse(`${day}T15:00:00Z`)+seconds*1000).toISOString(),window:index<2?1:2}));

it('fits, zooms and pans a street view without moving the saved GPS coordinates',()=>{
  const fit=fitTraceView(points);
  expect(fit.zoom).toBeGreaterThan(10);
  const zoomed=zoomTraceView(fit,1);
  expect(zoomed.zoom).toBe(fit.zoom+1);
  expect(panTraceView(zoomed,90,0,900,500).longitude).toBeLessThan(zoomed.longitude);
  expect(panTraceView(zoomed,0,90,900,500).latitude).toBeGreaterThan(zoomed.latitude);
});

it('provides a no-key Google directions link and a KML of the exact broken trace',()=>{
  const url=new URL(googleMapsRouteUrl(points)!);
  expect(url.host).toBe('www.google.com');
  expect(url.searchParams.get('api')).toBe('1');
  expect(url.searchParams.get('origin')).toBe('41.88000,-87.62000');
  expect(url.searchParams.get('destination')).toBe('41.88300,-87.62300');
  const kml=traceKml(day,points);
  expect(kml.match(/<LineString>/g)).toHaveLength(2);
  expect(kml).toContain('-87.620000,41.880000,0');
  expect(kml).toContain('-87.623000,41.883000,0');
  expect(kml).not.toContain('apiKey');
});
