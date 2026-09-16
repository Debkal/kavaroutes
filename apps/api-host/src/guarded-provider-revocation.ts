/** Bounded PostgreSQL + provider ports for provider-revocation sweeps.
 *
 * The guarded profile must be able to answer, for every active identity,
 * "is this provider account disabled, or has the provider revoked the
 * authentication this session was created from?" — and it must never scan
 * tenants or sessions without a bound.
 *
 * - Tenant enumeration goes through `platform.enrolled_tenants(maximum)`, the
 *   existing bounded, read-only, SECURITY DEFINER reader. Its hard maximum is
 *   100 tenants, so fleet coverage is bounded by that registry, not by an
 *   unrestricted query.
 * - Subjects are handed to the sweeper as opaque handles that encode the tenant
 *   and the provider subject; the sweeper never sees or invents either.
 * - Revocation compares the provider's `validSince` with the session row's own
 *   creation time (the persisted proxy for "when this session authenticated").
 *   The comparison is second-truncated on both sides, so a session created in
 *   the same second as a revocation is treated as revoked, matching the
 *   admission rule in `provider-session-revocation.ts`.
 */
import { withTenantTransaction } from '@kavaroutes/postgres-persistence';
import type { ProviderAccountState, ProviderRevocationPorts } from './provider-session-revocation.js';

/** Hard bound mirrored from `platform.enrolled_tenants(integer)`. */
export const GUARDED_TENANT_ENUMERATION_MAXIMUM = 100;

/** The opaque reference the sweeper and the admission gate share for one
 * tenant-scoped provider subject. Admission must use the same handle the sweep
 * produces, so both sides agree on which evidence applies to a request. */
export function subjectHandle(tenantId: string, subject: string): string {
  if (!uuid.test(tenantId) || typeof subject !== 'string' || subject.length < 1 || subject.length > 128) {
    throw new Error('PROVIDER_REVOCATION_SUBJECT_INVALID');
  }
  return Buffer.from(JSON.stringify([tenantId, subject]), 'utf8').toString('base64url');
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type Pool = Parameters<typeof withTenantTransaction>[0];

/** Provider side of the sweep: account state and token-revocation timestamp. */
export interface GuardedProviderAccounts {
  checkAccount(subject: string): Promise<ProviderAccountState>;
  /** Provider token-revocation timestamp (`validSince`), or `null` for none. */
  revokedAt(subject: string): Promise<string | null>;
}

export interface GuardedProviderRevocationOptions {
  readonly accounts: GuardedProviderAccounts;
  readonly tenantMaximum?: number;
}

export function createGuardedProviderRevocationPorts(pool: Pool, options: GuardedProviderRevocationOptions): ProviderRevocationPorts {
  const accounts = options.accounts;
  if (!accounts || typeof accounts.checkAccount !== 'function' || typeof accounts.revokedAt !== 'function') {
    throw new Error('GUARDED_PROVIDER_ACCOUNTS_INVALID');
  }
  const maximum = options.tenantMaximum ?? GUARDED_TENANT_ENUMERATION_MAXIMUM;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > GUARDED_TENANT_ENUMERATION_MAXIMUM) {
    throw new Error('GUARDED_PROVIDER_TENANT_BOUND_INVALID');
  }

  return Object.freeze({
    async listActiveSubjects(limit: number, after: string | null = null) {
      const cursor = after === null ? null : decodeHandle(after);
      if (after !== null && cursor === null) throw new Error('PROVIDER_REVOCATION_CURSOR_INVALID');
      const page: string[] = [];
      for (const tenantId of await enrolledTenants(pool, maximum)) {
        if (page.length >= limit) break;
        // Tenant-major ordering with the cursor carrying the position of the last
        // subject of the previous page: a resumed pass continues inside the
        // cursor tenant and starts each later tenant from its first subject.
        if (cursor && tenantId < cursor.tenantId) continue;
        const start = cursor && tenantId === cursor.tenantId ? cursor.subject : null;
        const rows = await withTenantTransaction(pool, tenantId, 'kavaroutes_api', async client => (await client.query(
          `SELECT DISTINCT subject FROM platform.application_session
            WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>statement_timestamp()
              AND ($2::text IS NULL OR subject>$2)
            ORDER BY subject LIMIT $3`, [tenantId, start, limit - page.length])).rows);
        for (const row of rows) page.push(encodeHandle(tenantId, String(row.subject)));
      }
      return page;
    },
    async checkAccount(subject: string) {
      const decoded = decodeHandle(subject);
      if (!decoded) return 'UNKNOWN';
      return accounts.checkAccount(decoded.subject);
    },
    async providerRevokedAt(subject: string) {
      const decoded = decodeHandle(subject);
      if (!decoded) throw new Error('PROVIDER_REVOCATION_SUBJECT_INVALID');
      const revokedAt = await accounts.revokedAt(decoded.subject);
      if (revokedAt === null || revokedAt === undefined) return null;
      if (!Number.isFinite(Date.parse(revokedAt))) throw new Error('PROVIDER_REVOCATION_TIMESTAMP_INVALID');
      return revokedAt;
    },
    async revokeSubject(subject: string, revokedAt: string | null) {
      const decoded = decodeHandle(subject);
      if (!decoded) throw new Error('PROVIDER_REVOCATION_SUBJECT_INVALID');
      return revokeSessions(pool, decoded.tenantId, decoded.subject, revokedAt);
    },
    async revokeAllActive() {
      let revoked = 0;
      for (const tenantId of await enrolledTenants(pool, maximum)) revoked += await revokeSessions(pool, tenantId, null, null);
      return revoked;
    },
  });
}

async function enrolledTenants(pool: Pool, maximum: number): Promise<readonly string[]> {
  const result = await pool.query('SELECT platform.enrolled_tenants($1) AS tenant_id', [maximum]);
  return result.rows.map(row => String(row.tenant_id)).filter(tenantId => uuid.test(tenantId)).sort();
}

async function revokeSessions(pool: Pool, tenantId: string, subject: string | null, revokedAt: string | null): Promise<number> {
  return withTenantTransaction(pool, tenantId, 'kavaroutes_api', async client => {
    const result = await client.query(
      `UPDATE platform.application_session SET revoked_at=COALESCE(revoked_at,statement_timestamp())
        WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>statement_timestamp()
          AND ($2::text IS NULL OR subject=$2)
          AND ($3::timestamptz IS NULL OR date_trunc('second',created_at)<=date_trunc('second',$3::timestamptz))`,
      [tenantId, subject, revokedAt]);
    return result.rowCount ?? 0;
  });
}

function encodeHandle(tenantId: string, subject: string): string {
  return subjectHandle(tenantId, subject);
}

function decodeHandle(handle: string): { readonly tenantId: string; readonly subject: string } | null {
  if (typeof handle !== 'string' || handle.length < 1 || handle.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(handle, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [tenantId, subject] = parsed as readonly unknown[];
    if (typeof tenantId !== 'string' || !uuid.test(tenantId)) return null;
    if (typeof subject !== 'string' || subject.length < 1 || subject.length > 128) return null;
    return { tenantId, subject };
  } catch { return null; }
}
