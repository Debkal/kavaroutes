import {useEffect,useMemo,useRef,useState} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type {createCloudApi} from '../cloud-api';
import {addAuthorizedStreetTiles} from './authorized-street-tiles';
import {RoadRouteMapPreview} from './RoadRouteMapPreview';

type Api=ReturnType<typeof createCloudApi>;

/** Geoapify's polyline5 geometry is already in the route response. */
export function decodeRoutePolyline(encoded:string):[number,number][]{
  const points:[number,number][]=[];
  let index=0,lat=0,lon=0;
  const delta=()=>{
    let value=0,shift=0;
    while(index<encoded.length){
      const byte=encoded.charCodeAt(index++)-63;
      if(byte<0||byte>63||shift>30)throw new Error('INVALID_ROAD_ROUTE_GEOMETRY');
      value|=(byte&31)<<shift;
      if(byte<32)return value&1?~(value>>1):value>>1;
      shift+=5;
    }
    throw new Error('INVALID_ROAD_ROUTE_GEOMETRY');
  };
  while(index<encoded.length){
    lat+=delta();lon+=delta();
    if(Math.abs(lat)>9_000_000||Math.abs(lon)>18_000_000||points.length>=20_000)throw new Error('INVALID_ROAD_ROUTE_GEOMETRY');
    points.push([lat/1e5,lon/1e5]);
  }
  if(points.length<2)throw new Error('INVALID_ROAD_ROUTE_GEOMETRY');
  return points;
}

export function InteractiveRoadRoutePreview({imageUrl,alt,api,encodedPolyline}:{imageUrl:string|null;alt:string;api:Api;encodedPolyline:string}){
  const container=useRef<HTMLDivElement>(null),map=useRef<any>(null);
  const [tileError,setTileError]=useState(false);
  const points=useMemo(()=>{
    if(!encodedPolyline)return null;
    try{return decodeRoutePolyline(encodedPolyline);}catch{return null;}
  },[api,encodedPolyline]);
  useEffect(()=>{
    if(!points||!container.current)return;
    setTileError(false);
    const instance=L.map(container.current,{minZoom:4,maxZoom:19,zoomControl:true,preferCanvas:true});
    map.current=instance;
    const removeTiles=addAuthorizedStreetTiles(instance,api,()=>setTileError(true));
    L.polyline(points,{color:'#17637c',weight:5,opacity:.94,smoothFactor:0}).addTo(instance);
    L.circleMarker(points[0]!,{radius:8,color:'#fff',weight:2,fillColor:'#2e7658',fillOpacity:1}).bindTooltip('Pickup').addTo(instance);
    L.circleMarker(points.at(-1)!,{radius:8,color:'#fff',weight:2,fillColor:'#af6546',fillOpacity:1}).bindTooltip('Drop-off').addTo(instance);
    instance.fitBounds(L.latLngBounds(points).pad(.12),{maxZoom:17});
    window.setTimeout(()=>instance.invalidateSize(),0);
    return()=>{removeTiles();instance.remove();map.current=null;};
  },[api,points]);
  if(!points)return <RoadRouteMapPreview imageUrl={imageUrl} alt={alt}/>;
  return <div className="road-route-map road-route-interactive">
    <div ref={container} className="route-street-viewport" role="region" aria-label={`Interactive ${alt}. Pan, pinch or scroll to zoom.`} tabIndex={0}/>
    <div className="road-route-map-controls"><button type="button" onClick={()=>map.current?.fitBounds(L.latLngBounds(points).pad(.12),{maxZoom:17})}>Fit route</button>
      <span><span className="route-leg-swatch" style={{backgroundColor:'#2e7658'}}/>Pickup <span className="route-leg-swatch" style={{backgroundColor:'#af6546'}}/>Drop-off</span></div>
    {tileError&&<p role="alert">Some street tiles could not load. Pan or zoom to retry.</p>}
  </div>;
}
