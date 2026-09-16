import type {FastifyInstance} from 'fastify';
import {createApplicationSessionStore,createIdentityMembershipReader} from '@kavaroutes/postgres-persistence';
import {createIdentityAdmission,type VerifiedIdentity} from '@kavaroutes/api-contracts/identity-admission';
import {registerBrowserAuth} from './browser-auth.js';
import {openHostGoogleIdentity} from './google-identity.js';

type DatabasePool=Parameters<typeof createApplicationSessionStore>[0];
interface BrowserAuthConfig { origin:string;signingKey:Buffer;pool:DatabasePool; }

/** Shared wiring for the verified provider and isolated provider-conformance
 * tests. No company creation, implicit email linking, or synthetic principal.
 */
export async function registerPostgresBrowserAuth(app:FastifyInstance,config:BrowserAuthConfig,
  verifyToken:(token:string)=>Promise<VerifiedIdentity>) {
  const store=createApplicationSessionStore(config.pool);
  const admission=createIdentityAdmission({verifyToken,findMembership:createIdentityMembershipReader(config.pool)},
    {issuer:'https://securetoken.google.com/kavaroutes',audience:'kavaroutes',
      now:()=>Math.floor(Date.now()/1000),maximumAuthenticationAgeSeconds:300});
  await registerBrowserAuth(app,{origin:config.origin,signingKey:config.signingKey,
    ports:{admit:admission.admit,issue:store.issue,resolve:store.resolve,revoke:store.revoke}});
}

/** Only reviewed live composition calls this; activation precedes SDK creation.
 * This does not authorize public ingress or protect unrelated business routes.
 */
export async function registerGooglePostgresBrowserAuth(app:FastifyInstance,config:BrowserAuthConfig & {
  authorizeActivation:()=>Promise<void>;
}) {
  const provider=await openHostGoogleIdentity(config.authorizeActivation);
  try {
    await registerPostgresBrowserAuth(app,config,provider.verifyToken);
    app.addHook('onClose',async()=>{await provider.close();});
  } catch(error) {await provider.close();throw error;}
}
