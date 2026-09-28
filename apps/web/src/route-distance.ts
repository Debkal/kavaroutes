export type RouteLine={window:number;coords:readonly (readonly [number,number])[]};
const rad=Math.PI/180;
export function lineMeters(coords:readonly (readonly [number,number])[]):number{
  let meters=0;
  for(let i=1;i<coords.length;i++){
    const [latA,lonA]=coords[i-1]!,[latB,lonB]=coords[i]!;
    const dLat=(latB-latA)*rad,dLon=(lonB-lonA)*rad;
    const a=Math.sin(dLat/2)**2+Math.cos(latA*rad)*Math.cos(latB*rad)*Math.sin(dLon/2)**2;
    meters+=6371008.8*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
  }
  return meters;
}
export function distanceByWindow(lines:readonly RouteLine[]):Map<number,number>{
  const result=new Map<number,number>();
  for(const line of lines)result.set(line.window,(result.get(line.window)??0)+lineMeters(line.coords));
  return result;
}
export const miles=(meters:number)=>`${(meters/1609.344).toFixed(1)} mi`;
