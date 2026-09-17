import type { FastifyInstance } from 'fastify';
import { createBrowserCredentials } from './browser-credentials.js';

interface AdmittedIdentity {
  organizationId:string;userId:string;principalId:string;issuer:string;subject:string;authorizationGeneration:number;
}
interface AuthPorts {
  // Must perform provider signature/revocation verification and exact active
  // membership admission. The browser must not supply any returned field.
  admit(token:string,organizationId:string):Promise<AdmittedIdentity>;
  issue(input:AdmittedIdentity & {tokenHash:string;csrfHash:string}):Promise<{expiresAt:string}>;
  /** Provider-gated persisted-session resolver. It returns the session row, or
   * `null` for a session the provider has terminally invalidated (disabled
   * account or revoked authentication), and **throws** (a `ProtocolError` with
   * status 503) when the provider cannot be consulted at all. Bootstrap and
   * business routes must both go through it, so a browser cannot be told it
   * still holds authority that the guarded REST/WebSocket surface refuses. */
  resolve(organizationId:string,tokenHash:string,csrfHash:string):Promise<unknown|null>;
  /** Ungated existence check, used **only** by `/auth/logout` when the gated
   * resolver is unavailable. It must not perform provider verification and must
   * not be reachable from any bootstrap or business path. */
  resolveForLogout(organizationId:string,tokenHash:string,csrfHash:string):Promise<unknown|null>;
  revoke(organizationId:string,tokenHash:string):Promise<void>;
}

/** Mount only on the reviewed HTTPS/proxy composition, never on the synthetic
 * public-token API. Provider credentials are transient body data, never logged.
 * This registers login/logout routes, not business-route authorization.
 */
export async function registerBrowserAuth(app:FastifyInstance,options:{
  origin:string;signingKey:Buffer;ports:AuthPorts;
}) {
  const credentials=createBrowserCredentials(options);
  // Single-process global ceiling protects even spoofed/distributed client IPs.
  // Distributed deployment requires a shared limiter, not copying this counter.
  let windowStart=Date.now(),attempts=0;
  await app.register(async routes=>{
    routes.addHook('onRequest',async(request,reply)=>{
      reply.header('Cache-Control','no-store').header('Pragma','no-cache');
      try {credentials.assertSameOrigin(request.headers);} catch {return reply.code(403).send({error:'SIGN_IN_NOT_AUTHORIZED'});}
      if(Date.now()-windowStart>=60_000){windowStart=Date.now();attempts=0;}
      if(++attempts>60)return reply.header('Retry-After','60').code(429).send({error:'AUTH_RATE_LIMITED'});
    });
    routes.setErrorHandler((_error,_request,reply)=>reply.code(400).send({error:'AUTH_REQUEST_INVALID'}));
    routes.post('/auth/challenge',{bodyLimit:1024},async(_request,reply)=>{
      const challenge=credentials.challenge();
      return reply.header('Set-Cookie',challenge.cookie).send({csrf:challenge.csrf});
    });
    routes.post('/auth/login',{bodyLimit:20*1024},async(request,reply)=>{
      try {
        credentials.verifyChallenge(request.headers.cookie,request.headers['x-kr-csrf']);
        const body=request.body;
        if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();
        const fields=body as Record<string,unknown>;
        if(Object.keys(fields).sort().join(',')!=='organizationId,token'||
          typeof fields.token!=='string'||fields.token.length<1||fields.token.length>16384||/\s/.test(fields.token)||
          typeof fields.organizationId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fields.organizationId))throw new Error();
        // Deny implicit session/company replacement. A separate authenticated
        // logout/recovery flow must finish before switching accounts.
        if(credentials.read(request.headers.cookie))throw new Error();
        const admitted=await options.ports.admit(fields.token,fields.organizationId);
        if(admitted.organizationId!==fields.organizationId)throw new Error();
        const issued=credentials.issue(admitted.organizationId);
        const saved=await options.ports.issue({...admitted,tokenHash:issued.tokenHash,csrfHash:issued.csrfHash});
        return reply.header('Set-Cookie',[issued.cookie,credentials.clearChallenge]).send({
          csrf:issued.csrf,expiresAt:saved.expiresAt,organizationId:admitted.organizationId,
        });
      } catch {return reply.code(401).send({error:'SIGN_IN_NOT_AUTHORIZED'});}
    });
    routes.post('/auth/logout',{bodyLimit:1024},async(request,reply)=>{
      try {
        const csrf=request.headers['x-kr-csrf'];
        if(typeof csrf!=='string')throw new Error();
        const session=credentials.read(request.headers.cookie,csrf);
        if(!session?.csrfHash)throw new Error();
        // Explicit logout-only rule: a provider this process cannot consult must
        // not trap a signed-in user in a session they asked to end. This branch
        // is *logout only* — it resolves the durable row itself, never through
        // the provider gate — and it cannot mint, extend or advertise authority:
        // the response is a 204 with cleared cookies. `/auth/session`, REST and
        // realtime all keep the provider-gated resolver and stay closed.
        let resolved=false;
        try { resolved=(await options.ports.resolve(session.organizationId,session.tokenHash,session.csrfHash))!==null; }
        catch { resolved=(await options.ports.resolveForLogout(session.organizationId,session.tokenHash,session.csrfHash))!==null; }
        if(!resolved)throw new Error();
        await options.ports.revoke(session.organizationId,session.tokenHash);
        return reply.header('Set-Cookie',[credentials.clearSession,credentials.clearChallenge]).code(204).send();
      } catch {return reply.code(401).send({error:'SIGN_IN_NOT_AUTHORIZED'});}
    });
    routes.post('/auth/session',{bodyLimit:1024},async(request,reply)=>{
      let session;
      try {session=credentials.recover(request.headers.cookie);} catch {
        return reply.header('Set-Cookie',credentials.clearSession).code(401).send({error:'SIGN_IN_NOT_AUTHORIZED'});
      }
      if(!session)return reply.code(401).send({error:'SIGN_IN_NOT_AUTHORIZED'});
      try {
        if(!await options.ports.resolve(session.organizationId,session.tokenHash,session.csrfHash)) {
          return reply.header('Set-Cookie',credentials.clearSession).code(401).send({error:'SIGN_IN_NOT_AUTHORIZED'});
        }
        // Origin is required by the enclosing hook. Read-only bootstrap has no
        // CSRF header yet, does not set cookies, and never extends expiry.
        return {organizationId:session.organizationId,csrf:session.csrf};
      } catch {return reply.code(503).send({error:'SESSION_UNAVAILABLE'});}
    });
  });
}
