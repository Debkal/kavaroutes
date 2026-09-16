/** Client-safe route contract; no server dependencies. */
export type RouteReceipt={proposalId:string;runId:string;runVersion:number;state:'PENDING_DISPATCH_APPROVAL'|'APPROVED'|'REJECTED'|'EXPIRED'|'CONFLICT'};
export type RouteRequest={proposalId:string;shiftGeneration:string;policyDigest:string;expectedRunVersion:number;expectedTag:string;nodeOrder:string[];parkedAttestation:true};
export type RouteView={shiftId:string;runId:string;runVersion:number;factsVersion:number;shiftGeneration:string;policyDigest:string;expectedTag:string;mode:'DISABLED'|'AUTHORIZED_SELF_APPROVE'|'DISPATCH_APPROVAL_REQUIRED';nodes:{nodeId:string;tripLegId:string|null;kind:'PICKUP'|'DROPOFF'|'BREAK'|'RETURN';locked:boolean}[];proposals:{proposalId:string;expectedTag:string;nodeOrder:string[];runVersion:number;state:RouteReceipt['state']}[]};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const states=['PENDING_DISPATCH_APPROVAL','APPROVED','REJECTED','EXPIRED','CONFLICT'];
const tag=(v:unknown)=>typeof v==='string'&&/^"kr1\.[A-Za-z0-9_-]{43}"$/.test(v);
function record(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==keys.sort().join())throw new Error('INVALID_ROUTE_RESPONSE');return v as Record<string,unknown>;}
const id=(v:unknown)=>typeof v==='string'&&uuid.test(v);
const version=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export function decodeRouteReceipt(v:unknown,proposalId:string):RouteReceipt{
 const r=record(v,['proposalId','runId','runVersion','state']);
 if(r.proposalId!==proposalId||!id(r.runId)||!version(r.runVersion)||!states.includes(String(r.state)))throw new Error('ROUTE_RECEIPT_MISMATCH');return r as RouteReceipt;
}
export function decodeRouteView(v:unknown,shiftId:string):RouteView{
 const r=record(v,['shiftId','runId','runVersion','factsVersion','shiftGeneration','policyDigest','expectedTag','mode','nodes','proposals']);
 if(!tag(r.expectedTag))throw new Error('INVALID_ROUTE_TAG');
 if(r.shiftId!==shiftId||!id(r.runId)||!id(r.shiftGeneration)||!version(r.runVersion)||!version(r.factsVersion)||typeof r.policyDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.policyDigest)||!['DISABLED','AUTHORIZED_SELF_APPROVE','DISPATCH_APPROVAL_REQUIRED'].includes(String(r.mode))||!Array.isArray(r.nodes)||r.nodes.length>500||!Array.isArray(r.proposals)||r.proposals.length>100)throw new Error('INVALID_ROUTE_VIEW');
 for(const raw of r.nodes){const n=record(raw,['nodeId','tripLegId','kind','locked']);if(!id(n.nodeId)||(n.tripLegId!==null&&!id(n.tripLegId))||!['PICKUP','DROPOFF','BREAK','RETURN'].includes(String(n.kind))||typeof n.locked!=='boolean')throw new Error('INVALID_ROUTE_NODE');}
 const ids=new Set(r.nodes.map(n=>n.nodeId));if(ids.size!==r.nodes.length)throw new Error('DUPLICATE_ROUTE_NODE');
 for(const raw of r.proposals){const p=record(raw,['proposalId','expectedTag','nodeOrder','runVersion','state']);if(!tag(p.expectedTag)||!id(p.proposalId)||!version(p.runVersion)||!states.includes(String(p.state))||!Array.isArray(p.nodeOrder)||p.nodeOrder.length>500||p.nodeOrder.some(n=>!id(n)))throw new Error('INVALID_ROUTE_PROPOSAL');}
 return r as RouteView;
}
