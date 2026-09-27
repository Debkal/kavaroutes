export interface MapView {readonly latitude:number;readonly longitude:number;readonly zoom:number}
export interface MapFix {readonly latitude:number;readonly longitude:number}

const radians=Math.PI/180;
const mercator=(latitude:number)=>Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,latitude))*radians/2));
const latitudeFromMercator=(value:number)=>Math.atan(Math.sinh(value))/radians;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

/** Use Web Mercator bounds so the initial server-rendered image fits the GPS trace. */
export function fitTraceView(points:readonly MapFix[]):MapView{
  if(!points.length)throw new Error('TRACE_REQUIRED');
  const west=Math.min(...points.map(point=>point.longitude)),east=Math.max(...points.map(point=>point.longitude));
  const south=Math.min(...points.map(point=>mercator(point.latitude))),north=Math.max(...points.map(point=>mercator(point.latitude)));
  const horizontal=(east-west)/360,vertical=(north-south)/(2*Math.PI);
  const zoom=clamp(Math.floor(Math.log2(Math.min(800/(256*Math.max(horizontal,1e-8)),400/(256*Math.max(vertical,1e-8))))),4,18);
  return {latitude:latitudeFromMercator((north+south)/2),longitude:(west+east)/2,zoom};
}

export function zoomTraceView(view:MapView,delta:number):MapView{return {...view,zoom:clamp(view.zoom+delta,4,19)};}

/** Pixel drag offsets are relative to the displayed 900×500 image. */
export function panTraceView(view:MapView,deltaX:number,deltaY:number,width:number,height:number):MapView{
  if(width<=0||height<=0)return view;
  const world=256*2**view.zoom;
  const longitude=clamp(view.longitude-deltaX*900/width*360/world,-180,180);
  const latitude=clamp(latitudeFromMercator(mercator(view.latitude)+deltaY*500/height*2*Math.PI/world),-85,85);
  return {latitude,longitude,zoom:view.zoom};
}
