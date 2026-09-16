import type { Pool } from 'pg';

/** Bounded, authorized worker tenant enrollment. The worker processes only
 * tenants an operator enrolled; ids are validated before use and the bound is
 * enforced again inside the database function. */
export function createWorkerTenantReader(pool: Pool) {
  return Object.freeze({
    async enrolled(maximum: number): Promise<string[]> {
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('ENROLLMENT_BOUND_INVALID');
      const rows = (await pool.query('SELECT platform.enrolled_tenants($1) AS tenant_id', [maximum])).rows;
      return rows.map(row => {
        const tenant = String(row.tenant_id ?? '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tenant)) {
          throw new Error('ENROLLMENT_TENANT_INVALID');
        }
        return tenant;
      });
    },
  });
}
