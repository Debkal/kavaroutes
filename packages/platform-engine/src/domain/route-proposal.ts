/** Pure route feasibility, evaluated against locked server-owned planning facts.
 * No tier, provider response or client-supplied constraint grants approval.
 */
export type RouteNode = Readonly<{
 id:string;legId:string|null;kind:'PICKUP'|'DROPOFF'|'BREAK'|'RETURN';locked:boolean;
 earliest:number;latest:number;serviceSeconds:number;
}>;
export type RouteLegConstraint=Readonly<{legId:string;seats:number;wheelchairSpaces:number;maximumRideSeconds:number}>;
export type RouteFeasibility=Readonly<{
 startAt:number;returnBy:number;startNode:string;requiredReturnNode:string|null;
 seats:number;wheelchairSpaces:number;legs:readonly RouteLegConstraint[];
 travelSeconds:Readonly<Record<string,number>>;
}>;
export class RouteProposalConflict extends Error {
 constructor(readonly code:string){super(code);this.name='RouteProposalConflict';}
}
const fail=(code:string):never=>{throw new RouteProposalConflict(code);};
const finite=(value:number,min=0)=>Number.isSafeInteger(value)&&value>=min;
export function validateFutureRoute(nodes:readonly RouteNode[],order:readonly string[],rules:RouteFeasibility){
 if(nodes.length<2||nodes.length>500||order.length!==nodes.length||new Set(nodes.map(n=>n.id)).size!==nodes.length||new Set(order).size!==order.length)fail('ROUTE_NODE_SET_INVALID');
 const byId=new Map(nodes.map(n=>[n.id,n]));
 if(order.some(id=>!byId.has(id)))fail('ROUTE_OWNERSHIP_MISMATCH');
 if(!finite(rules.startAt)||!finite(rules.returnBy)||rules.returnBy<rules.startAt||!finite(rules.seats,1)||!finite(rules.wheelchairSpaces))fail('ROUTE_CONSTRAINTS_REQUIRED');
 const legs=new Map(rules.legs.map(l=>[l.legId,l]));
 if(legs.size!==rules.legs.length||rules.legs.some(l=>!finite(l.seats,1)||!finite(l.wheelchairSpaces)||!finite(l.maximumRideSeconds,1)))fail('ROUTE_CONSTRAINTS_REQUIRED');
 for(const node of nodes){
  if(!['PICKUP','DROPOFF','BREAK','RETURN'].includes(node.kind)||typeof node.locked!=='boolean')fail('ROUTE_NODE_SET_INVALID');
  if(!finite(node.earliest)||!finite(node.latest)||node.latest<node.earliest||!finite(node.serviceSeconds))fail('ROUTE_CONSTRAINTS_REQUIRED');
  if((node.kind==='PICKUP'||node.kind==='DROPOFF')&&(!node.legId||!legs.has(node.legId)))fail('ROUTE_CONSTRAINTS_REQUIRED');
  if((node.kind==='BREAK'||node.kind==='RETURN')&&node.legId!==null)fail('ROUTE_NODE_SET_INVALID');
 }
 // A conservative supported lane: started/onboard legs are frozen as an entire pair.
 // Nodes before the last locked node cannot move across that boundary.
 const lastLocked=nodes.reduce((last,node,index)=>node.locked?index:last,-1);
 for(let i=0;i<=lastLocked;i++)if(order[i]!==nodes[i]!.id)fail('STARTED_OR_LOCKED_NODE');
 if(rules.requiredReturnNode && (order.at(-1)!==rules.requiredReturnNode||byId.get(rules.requiredReturnNode)?.kind!=='RETURN'))fail('BREAK_OR_RETURN');
 const pickups=new Set<string>(),dropoffs=new Set<string>(),onboard=new Map<string,number>();
 let seats=0,wheelchairs=0,at=rules.startAt,previous=rules.startNode;
 const schedule:{nodeId:string;arriveAt:number;departAt:number}[]=[];
 for(const id of order){
  const node=byId.get(id)!;
  const travel=rules.travelSeconds[`${previous}:${id}`];
  if(travel===undefined||!finite(travel))fail('TRAVEL_CONSTRAINTS_REQUIRED');
  at=Math.max(at+travel!*1000,node.earliest);
  if(at>node.latest)fail('TIME_WINDOW');
  const arriveAt=at;
  if(node.kind==='PICKUP'){
   if(pickups.has(node.legId!))fail('PICKUP_DROPOFF_INVERSION');
   const leg=legs.get(node.legId!)!;pickups.add(node.legId!);seats+=leg.seats;wheelchairs+=leg.wheelchairSpaces;
   if(seats>rules.seats||wheelchairs>rules.wheelchairSpaces)fail('CAPACITY');
   onboard.set(node.legId!,at+node.serviceSeconds*1000);
  }else if(node.kind==='DROPOFF'){
   const boarded=onboard.get(node.legId!);if(boarded===undefined||dropoffs.has(node.legId!))fail('PICKUP_DROPOFF_INVERSION');
   const leg=legs.get(node.legId!)!;if(at-boarded!>leg.maximumRideSeconds*1000)fail('MAXIMUM_RIDE');
   dropoffs.add(node.legId!);onboard.delete(node.legId!);seats-=leg.seats;wheelchairs-=leg.wheelchairSpaces;
  }else if(node.kind==='RETURN' && onboard.size)fail('ONBOARD_RETURN');
  at+=node.serviceSeconds*1000;if(at>rules.returnBy)fail('BREAK_OR_RETURN');
  schedule.push({nodeId:id,arriveAt,departAt:at});previous=id;
 }
 if(onboard.size||pickups.size!==legs.size||dropoffs.size!==legs.size)fail('PICKUP_DROPOFF_INVERSION');
 return Object.freeze(schedule);
}
