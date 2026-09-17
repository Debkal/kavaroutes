import type {FastifyInstance} from 'fastify';
import {createApplicationSessionStore,createIdentityMembershipReader} from '@kavaroutes/postgres-persistence';
import {createIdentityAdmission,type VerifiedIdentity} from '@kavaroutes/api-contracts/identity-admission';
import {registerBrowserAuth} from './browser-auth.js';
import {openHostGoogleIdentity} from './google-identity.js';

type DatabasePool=Parameters<typeof createApplicationSessionStore>[0];
interface BrowserAuthConfig { origin:string;signingKey:Buffer;pool:DatabasePool; }

export interface BrowserProviderGate {
  /** Provider-gated validity decision for one persisted session. `null` means
   * terminal invalidity; a thrown `ProtocolError(503)` means the provider could
   * not be consulted. Required: an ungated resolver here would let `/auth/session`
   * advertise authority the business routes refuse. */
  authorize(session:{readonly organizationId:string;readonly subject:string;readonly createdAt:string})
    :Promise<'ALLOWED'|'DENIED'|'UNAVAILABLE'>;
}

/** Shared wiring for the verified provider and isolated provider-conformance
 * tests. No company creation, implicit email linking, or synthetic principal.
 * The provider gate is not optional; only the explicit logout-only existence
 * check (`store.resolve`) bypasses it, and that check grants nothing.
 */
export async function registerPostgresBrowserAuth(app:FastifyInstance,config:BrowserAuthConfig,
  verifyToken:(token:string)=>Promise<VerifiedIdentity>,gate:BrowserProviderGate) {
  const store=createApplicationSessionStore(config.pool);
  const admission=createIdentityAdmission({verifyToken,findMembership:createIdentityMembershipReader(config.pool)},
    {issuer:'https://securetoken.google.com/kavaroutes',audience:'kavaroutes',
      now:()=>Math.floor(Date.now()/1000),maximumAuthenticationAgeSeconds:300});
  const resolve=async(organizationId:string,tokenHash:string,csrfHash:string)=>{
    const row=await store.resolve(organizationId,tokenHash,csrfHash);
    if(!row)return null;
    const decision=await gate.authorize({organizationId,subject:String(row.subject),createdAt:String(row.createdAt)});
    if(decision==='ALLOWED')return row;
    if(decision==='DENIED')return null;
    throw new Error('PROVIDER_VERIFICATION_UNAVAILABLE');
  };
  await registerBrowserAuth(app,{origin:config.origin,signingKey:config.signingKey,
    ports:{admit:admission.admit,issue:store.issue,resolve,resolveForLogout:store.resolve,revoke:store.revoke}});
}

/** Only reviewed live composition calls this; activation precedes SDK creation.
 * This does not authorize public ingress or protect unrelated business routes.
 */
export async function registerGooglePostgresBrowserAuth(app:FastifyInstance,config:BrowserAuthConfig & {
  authorizeActivation:()=>Promise<void>;
}) {
  const provider=await openHostGoogleIdentity(config.authorizeActivation);
  try {
    // The live composition always has a provider: `lookupAccount` answers both
    // "is this account disabled" and "was this authentication revoked". The
    // decision helper is defined once here so the browser bootstrap cannot
    // disagree with REST/WebSocket about what the provider says.
    await registerPostgresBrowserAuth(app,config,provider.verifyToken,
      {authorize:async session=>{
        try {
          const account=await provider.lookupAccount(session.subject);
          if(account.disabled===true)return 'DENIED';
          if(account.revokedAt===null||account.revokedAt===undefined)return 'ALLOWED';
          const validSince=Date.parse(account.revokedAt),authenticatedAt=Date.parse(session.createdAt);
          if(!Number.isFinite(validSince)||!Number.isFinite(authenticatedAt))return 'UNAVAILABLE';
          // Second-granular `validSince`, matching provider-session-revocation.ts:
          // a session authenticated in the same second as the revocation is
          // ambiguous and is refused.
          return Math.floor(validSince/1000)>=Math.floor(authenticatedAt/1000)?'DENIED':'ALLOWED';
        } catch {return 'UNAVAILABLE';}
      }});
    app.addHook('onClose',async()=>{await provider.close();});
  } catch(error) {await provider.close();throw error;}
}
