import type { Pool } from 'pg';
import { withTenantTransaction } from './repositories.js';

const digest = /^[a-f0-9]{64}$/;
function checkDigest(value: string) {
  if (typeof value !== 'string' || !digest.test(value)) throw new Error('SESSION_CREDENTIAL_INVALID');
}

/** Server-only persistence. Caller must verify provider identity before issuing.
 * Store only SHA-256 digests of independent cryptographically random credentials.
 * Every REST request / websocket authorization recheck must resolve again.
 */
export function createApplicationSessionStore(pool: Pool) {
  return Object.freeze({
    async issue(input: { organizationId: string; userId: string; principalId: string;
      issuer: string; subject: string; authorizationGeneration: number; tokenHash: string; csrfHash: string }) {
      checkDigest(input.tokenHash); checkDigest(input.csrfHash);
      if (!Number.isSafeInteger(input.authorizationGeneration) || input.authorizationGeneration<1) throw new Error('SESSION_ADMISSION_INVALID');
      return withTenantTransaction(pool,input.organizationId,'kavaroutes_api',async c => {
        // One statement observes/rechecks the admission binding and records its
        // generation. A concurrent revocation makes the resulting session unusable.
        const result = await c.query(`INSERT INTO platform.application_session
          (tenant_id,user_id,principal_id,issuer,subject,authorization_generation,token_hash,csrf_hash,created_at,expires_at)
          SELECT m.tenant_id,m.user_id,m.principal_id,b.issuer,b.subject,m.authorization_generation,$7,$8,
            statement_timestamp(),statement_timestamp()+interval '1 hour'
          FROM platform.application_membership m
          JOIN platform.application_user u ON u.tenant_id=m.tenant_id AND u.id=m.user_id
          JOIN platform.identity_binding b ON b.tenant_id=m.tenant_id AND b.user_id=m.user_id
          WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.principal_id=$3 AND b.issuer=$4 AND b.subject=$5
            AND m.authorization_generation=$6 AND m.active AND u.active AND b.active
          RETURNING expires_at`, [input.organizationId,input.userId,input.principalId,input.issuer,input.subject,
          input.authorizationGeneration,input.tokenHash,input.csrfHash]);
        if (result.rowCount!==1) throw new Error('SESSION_ADMISSION_DENIED');
        return { expiresAt: new Date(result.rows[0].expires_at).toISOString() };
      },'serializable');
    },
    /** Resolves the session together with its explicit persisted scope and
     * capability grants. A membership without grants resolves with empty sets
     * and therefore holds no scoped authority. */
    async resolve(organizationId: string, tokenHash: string, csrfHash?: string) {
      checkDigest(tokenHash); if(csrfHash!==undefined) checkDigest(csrfHash);
      return withTenantTransaction(pool,organizationId,'kavaroutes_api',async c => {
        const row=(await c.query(`SELECT m.user_id,m.principal_id,m.role,m.driver_id,m.authorization_generation,s.expires_at,s.subject,s.created_at,
            COALESCE((SELECT array_agg(g.scope_kind ORDER BY g.scope_kind) FROM platform.membership_scope_grant g
              WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.active),'{}') AS scope_kinds,
            COALESCE((SELECT array_agg(g.capability ORDER BY g.capability) FROM platform.membership_capability_grant g
              WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.active),'{}') AS capability_grants
          FROM platform.application_session s
          JOIN platform.application_membership m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
          JOIN platform.application_user u ON u.tenant_id=m.tenant_id AND u.id=m.user_id
          JOIN platform.identity_binding b ON b.tenant_id=s.tenant_id AND b.user_id=s.user_id AND b.issuer=s.issuer AND b.subject=s.subject
          WHERE s.tenant_id=$1 AND s.token_hash=$2 AND ($3::text IS NULL OR s.csrf_hash=$3)
            AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
            AND s.authorization_generation=m.authorization_generation AND s.principal_id=m.principal_id
            AND m.active AND u.active AND b.active`,[organizationId,tokenHash,csrfHash??null])).rows[0];
        if(!row) return null;
        const generation=Number(row.authorization_generation);
        if(!Number.isSafeInteger(generation)||generation<1) throw new Error('SESSION_GENERATION_INVALID');
        const rawKinds:unknown=row.scope_kinds;
        const scopeKinds:string[]=Array.isArray(rawKinds)?rawKinds.map(value=>String(value)):[];
        if(scopeKinds.some(kind=>!['BRANCH','FLEET'].includes(kind))) throw new Error('SESSION_SCOPE_INVALID');
        const rawCapabilities:unknown=row.capability_grants;
        const capabilityGrants:string[]=Array.isArray(rawCapabilities)?rawCapabilities.map(value=>String(value)):[];
        return { organizationId,userId:String(row.user_id),principalId:String(row.principal_id),
          role:row.role as 'DRIVER'|'DISPATCHER',driverId:row.driver_id===null?null:String(row.driver_id),
          authorizationGeneration:generation,expiresAt:new Date(row.expires_at).toISOString(),
          scopeKinds,capabilityGrants,
          // Provider subject and the session's own creation time: provider
          // revocation propagation compares the provider's `validSince` with
          // this timestamp, and never treats "account enabled" as "authentication
          // still valid".
          subject:String(row.subject),createdAt:new Date(row.created_at).toISOString() };
      });
    },
    async revoke(organizationId: string,tokenHash: string) {
      checkDigest(tokenHash);
      await withTenantTransaction(pool,organizationId,'kavaroutes_api',async c => {
        await c.query(`UPDATE platform.application_session SET revoked_at=COALESCE(revoked_at,statement_timestamp())
          WHERE tenant_id=$1 AND token_hash=$2`,[organizationId,tokenHash]);
      });
    },
  });
}
