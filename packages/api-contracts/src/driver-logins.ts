import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {Type,type Static} from 'typebox';
import {createPostgresPersistence,PersistenceConflict,verifyDriverLogin,withTenantTransaction,type DriverCredentialState} from '@kavaroutes/postgres-persistence';
import {authorize,companyBranchScope,companyFleetScope,type SyntheticPrincipal} from './security.js';
import {ProtocolError,requestFingerprint} from './protocol.js';

const id=()=>Type.String({format:'uuid'});
const instant=()=>Type.String({format:'date-time'});
const loginId=()=>Type.String({pattern:'^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'});
const STATUSES=['INVITED','ACTIVE','LOCKED'] as const;
const DriverWorkforceRelationshipSchema=Type.Union([Type.Literal('OWNER_OPERATOR'),Type.Literal('EMPLOYEE'),Type.Literal('CONTRACTOR')]);

/** Dispatch issues the login, the driver
 * claims it on their designated phone and sets their own password, so each driver keeps
 * a separate credential. Only hashes are stored (see migration 0033). */
export const DriverLoginCreateRequestSchema=Type.Object({driverId:id(),loginId:loginId()},{additionalProperties:false,$id:'DriverLoginCreateRequest'});
export type DriverLoginCreateRequest=Static<typeof DriverLoginCreateRequestSchema>;
export const DriverAccountCreateRequestSchema=Type.Object({
 displayName:Type.String({minLength:1,maxLength:120}),loginId:loginId(),
 workforceRelationship:DriverWorkforceRelationshipSchema,
},{additionalProperties:false,$id:'DriverAccountCreateRequest'});
export type DriverAccountCreateRequest=Static<typeof DriverAccountCreateRequestSchema>;
export const DriverAccountReceiptSchema=Type.Object({driverId:id(),displayName:Type.String({minLength:1,maxLength:120}),
 workforceRelationship:DriverWorkforceRelationshipSchema,loginId:loginId(),
 inviteCode:Type.String({minLength:8,maxLength:64}),status:Type.Literal('INVITED'),version:Type.Integer({minimum:1})
},{additionalProperties:false,$id:'DriverAccountReceipt'});
export type DriverAccountReceipt=Static<typeof DriverAccountReceiptSchema>;
export const DriverLoginReceiptSchema=Type.Object({driverId:id(),loginId:loginId(),inviteCode:Type.String({minLength:8,maxLength:64}),
 status:Type.Literal('INVITED'),version:Type.Integer({minimum:1})},{additionalProperties:false,$id:'DriverLoginReceipt'});
export type DriverLoginReceipt=Static<typeof DriverLoginReceiptSchema>;
export const DriverLoginClaimRequestSchema=Type.Object({driverId:id(),inviteCode:Type.String({minLength:8,maxLength:64}),
 password:Type.String({minLength:8,maxLength:200}),installation:Type.Optional(Type.String({minLength:4,maxLength:128}))},{additionalProperties:false,$id:'DriverLoginClaimRequest'});
export type DriverLoginClaimRequest=Static<typeof DriverLoginClaimRequestSchema>;
export const DriverLoginVerifyRequestSchema=Type.Object({loginId:loginId(),password:Type.String({minLength:8,maxLength:200})},{additionalProperties:false,$id:'DriverLoginVerifyRequest'});
export type DriverLoginVerifyRequest=Static<typeof DriverLoginVerifyRequestSchema>;
export const DriverLoginStateSchema=Type.Object({driverId:id(),loginId:loginId(),
 status:Type.Union([Type.Literal('INVITED'),Type.Literal('ACTIVE'),Type.Literal('LOCKED')]),
 claimedAt:Type.Union([instant(),Type.Null()]),lastLoginAt:Type.Union([instant(),Type.Null()]),version:Type.Integer({minimum:1}),
 sessionToken:Type.Optional(Type.String({pattern:'^dvs_[A-Za-z0-9_-]{43}$'}))},{additionalProperties:false,$id:'DriverLoginState'});
export type DriverLoginState=Static<typeof DriverLoginStateSchema>;

/** The stored status is constraint-bound, but the contract still narrows it instead of
 * trusting the persistence type through the package boundary. */
const toState=(state:DriverCredentialState):DriverLoginState=>{
 if(!STATUSES.includes(state.status as (typeof STATUSES)[number]))throw new PersistenceConflict('relationship','driver login status is not a reviewed value');
 return {driverId:state.driverId,loginId:state.loginId,status:state.status as DriverLoginState['status'],
  claimedAt:state.claimedAt,lastLoginAt:state.lastLoginAt,version:state.version};
};

export function createPostgresDriverLoginService(pool:Pool,options:{allowUnauthenticatedLogin?:boolean}={}){
 const persistence=createPostgresPersistence(pool);
 const dispatchAccess=(organizationId:string,principal:SyntheticPrincipal)=>authorize(principal,organizationId,{capability:'dispatch:command',
  purpose:'ASSIGNED_SERVICE_DELIVERY',branchScope:companyBranchScope(organizationId),fleetScope:companyFleetScope(organizationId)});
 const driverAccess=(organizationId:string,principal:SyntheticPrincipal)=>authorize(principal,organizationId,{capability:'driver:execute',purpose:'ASSIGNED_SERVICE_DELIVERY'});
 const mutation=<T,>(input:{organizationId:string;actorReference:string;operationId:string;key:string;fingerprint:string},
   work:(tx:Parameters<Parameters<typeof persistence.executeIdempotentMutation<T>>[1]>[0])=>Promise<{statusCode:number;body:T;headers:Readonly<Record<string,string>>;resultReference:string}>) =>
  persistence.executeIdempotentMutation<T>({tenantId:input.organizationId,actorReference:input.actorReference,operationId:input.operationId,
   key:input.key,fingerprint:input.fingerprint,recordId:randomUUID(),expiresAt:new Date(Date.now()+86_700_000),isolationLevel:'serializable'},work);
 return Object.freeze({
  async createAccount(input:{organizationId:string;principal:SyntheticPrincipal;key:string;request:DriverAccountCreateRequest}){
   dispatchAccess(input.organizationId,input.principal);
   const displayName=input.request.displayName.trim();
   if(!displayName)throw new ProtocolError(422,'DRIVER_NAME_REQUIRED','driver display name is required');
   const fingerprint=requestFingerprint({kind:'createDriverAccount',displayName,loginId:input.request.loginId,workforceRelationship:input.request.workforceRelationship});
   return mutation<DriverAccountReceipt>({organizationId:input.organizationId,actorReference:input.principal.id,operationId:'createDriverAccount',
    key:input.key,fingerprint},async tx=>{
    const account=await tx.createDriverAccount({driverId:randomUUID(),displayName,loginId:input.request.loginId,
      workforceRelationship:input.request.workforceRelationship});
    const receipt:DriverAccountReceipt={driverId:account.driverId,displayName:account.displayName,
      workforceRelationship:account.workforceRelationship,loginId:account.loginId,inviteCode:account.inviteCode,status:'INVITED',version:account.version};
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:'driver-account',aggregateId:account.driverId,aggregateVersion:1,
      actionReference:'driver.account.created',actorReference:input.principal.id});
    return {statusCode:201,body:receipt,headers:{},resultReference:account.driverId};
   });
  },
  async create(input:{organizationId:string;principal:SyntheticPrincipal;key:string;request:DriverLoginCreateRequest}){
   dispatchAccess(input.organizationId,input.principal);
   const fingerprint=requestFingerprint({kind:'createDriverLogin',...input.request});
   return mutation<DriverLoginReceipt>({organizationId:input.organizationId,actorReference:input.principal.id,operationId:'createDriverLogin',
     key:input.key,fingerprint},async tx=>{
    const invite=await tx.createDriverCredential({driverId:input.request.driverId,loginId:input.request.loginId});
    const receipt:DriverLoginReceipt={driverId:invite.driverId,loginId:invite.loginId,inviteCode:invite.inviteCode,status:'INVITED',version:invite.version};
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:'driver-login',aggregateId:invite.driverId,aggregateVersion:invite.version,
      actionReference:'driver.login.invited',actorReference:input.principal.id});
    return {statusCode:201,body:receipt,headers:{},resultReference:invite.driverId};
   });
  },
  async claim(input:{organizationId:string;principal?:SyntheticPrincipal;driverId:string;key:string;request:DriverLoginClaimRequest}){
   if(input.principal)driverAccess(input.organizationId,input.principal);
   else if(!options.allowUnauthenticatedLogin)throw new ProtocolError(401,'AUTHENTICATION_REQUIRED','authentication required');
   // An authenticated driver can only claim their own login. A public claim is
   // authorized by the one-time invite code inside the credential transaction.
   if(input.principal && input.principal.subjectId!==input.driverId)
     throw new ProtocolError(403,'DRIVER_LOGIN_DRIVER_MISMATCH','this login belongs to another driver');
   const fingerprint=requestFingerprint({kind:'claimDriverLogin',...input.request});
   const result=await mutation<DriverLoginState>({organizationId:input.organizationId,actorReference:input.principal?.id??input.driverId,operationId:'claimDriverLogin',
     key:input.key,fingerprint},async tx=>{
    let state;
    try {
      state=toState(await tx.claimDriverCredential({driverId:input.driverId,inviteCode:input.request.inviteCode,
        password:input.request.password,...(input.request.installation?{installation:input.request.installation}:{})}));
    } catch (error) {
      // A claim refusal is a state conflict with a name, not a missing resource: the
      // login exists but cannot be claimed with what was supplied (audit WEB-A-003/024).
      if (error instanceof PersistenceConflict) throw new ProtocolError(409,'DRIVER_LOGIN_NOT_CLAIMABLE','this login cannot be claimed with that code');
      throw error;
    }
    await tx.appendAudit({auditId:randomUUID(),aggregateKind:'driver-login',aggregateId:state.driverId,aggregateVersion:state.version,
      actionReference:'driver.login.claimed',actorReference:state.driverId});
    return {statusCode:200,body:state,headers:{},resultReference:state.driverId};
   });
   return result.body;
  },
  async verify(input:{organizationId:string;principal?:SyntheticPrincipal;key:string;request:DriverLoginVerifyRequest}){
   if(input.principal)driverAccess(input.organizationId,input.principal);
   else if(!options.allowUnauthenticatedLogin)throw new ProtocolError(401,'AUTHENTICATION_REQUIRED','authentication required');
   // A password check is not replayed state: it runs once, in its own tenant
   // transaction, so the failed-attempt counter and the lockout commit even when the
   // attempt is refused. The answer is identical for an unknown phone, an unclaimed
   // login, a wrong password and a locked login.
   const attempt=await withTenantTransaction(pool,input.organizationId,'kavaroutes_api',
     client=>verifyDriverLogin(client,input.organizationId,{loginId:input.request.loginId,password:input.request.password}));
   if(!attempt.accepted||!attempt.state)throw new ProtocolError(401,'DRIVER_LOGIN_REJECTED','driver login rejected');
   return toState(attempt.state);
  },
 });
}
export type DriverLoginService=ReturnType<typeof createPostgresDriverLoginService>;
