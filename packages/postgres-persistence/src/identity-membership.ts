import type { Pool } from 'pg';
import { withTenantTransaction } from './repositories.js';

/** Read after provider verification. Never bind by email or create a membership. */
export function createIdentityMembershipReader(pool: Pool) {
  return async (issuer: string, subject: string, organizationId: string) =>
    withTenantTransaction(pool, organizationId, 'kavaroutes_api', async client => {
      const row = (await client.query(`SELECT u.id AS user_id,m.principal_id,m.tenant_id,
        b.issuer,b.subject,u.active AS user_active,m.active AS membership_active,m.authorization_generation
        FROM platform.identity_binding b
        JOIN platform.application_user u ON u.tenant_id=b.tenant_id AND u.id=b.user_id
        JOIN platform.application_membership m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
        WHERE b.tenant_id=$1 AND b.issuer=$2 AND b.subject=$3 AND b.active`,
      [organizationId, issuer, subject])).rows[0];
      if (!row) return null;
      const generation = Number(row.authorization_generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('IDENTITY_GENERATION_INVALID');
      return { userId: String(row.user_id), principalId: String(row.principal_id), organizationId: String(row.tenant_id),
        identityIssuer: String(row.issuer), identitySubject: String(row.subject), userActive: row.user_active === true,
        membershipActive: row.membership_active === true, authorizationGeneration: generation };
    }, 'serializable');
}
