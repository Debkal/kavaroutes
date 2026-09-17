import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {PersistenceConflict,withTenantTransaction} from "./repositories.js";

/**
 * Dispatch-authored client intake. A client is the retained facility record widened
 * with the operator fields dispatch collects, plus the trip pattern the client books:
 * one pickup address, one or more drop-off addresses, and whether the trip returns.
 * The pickup lives on intake.facility.address_id and each drop-off is an ordered
 * intake.client_dropoff row pointing at its own intake.address row, so a run plan can
 * turn a drop-off into a leg instead of parsing a free-text list.
 */
export type ClientTripType = "ONE_WAY" | "ROUND_TRIP";
export interface ClientIntakeInput {
  readonly displayName: string;
  readonly entityName: string | null;
  readonly phone: string | null;
  readonly pickupAddress: string | null;
  readonly dropoffAddresses: readonly string[];
  readonly tripType: ClientTripType | null;
  readonly notes: string | null;
}
export interface ClientIntakeReceipt {
  readonly clientId: string;
  readonly version: number;
  readonly dropoffCount: number;
}
export interface ClientRouteView {
  readonly tripId: string;
  readonly serviceDate: string;
}
export interface ClientDropoffView {
  readonly ordinal: number;
  readonly addressLabel: string;
  readonly usageCount: number;
  readonly lastUsedAt: string | null;
}
export interface ClientRecordView {
  readonly clientId: string;
  readonly displayName: string;
  readonly entityName: string | null;
  readonly phone: string | null;
  readonly pickupAddress: string | null;
  readonly dropoffAddresses: readonly ClientDropoffView[];
  readonly tripType: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly routes: readonly ClientRouteView[];
}

export async function createClientRecord(client: PoolClient, tenantId: string, input: ClientIntakeInput): Promise<ClientIntakeReceipt> {
  const clientId = randomUUID(), pickupAddressId = randomUUID();
  await client.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES($1,$2,$3)",
    [tenantId, pickupAddressId, input.pickupAddress ?? input.displayName]);
  const row = (await client.query(`INSERT INTO intake.facility
    (tenant_id,id,address_id,synthetic_label,display_name,entity_name,phone,notes,trip_type)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING aggregate_version`,
  [tenantId, clientId, pickupAddressId, input.displayName, input.displayName, input.entityName, input.phone, input.notes, input.tripType])).rows[0];
  if (!row) throw new PersistenceConflict("relationship", "client could not be recorded");
  for (const [index, label] of input.dropoffAddresses.entries()) {
    const addressId = randomUUID();
    await client.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES($1,$2,$3)", [tenantId, addressId, label]);
    await client.query("INSERT INTO intake.client_dropoff(tenant_id,facility_id,ordinal,address_id) VALUES($1,$2,$3,$4)",
      [tenantId, clientId, index + 1, addressId]);
  }
  return {clientId, version: Number(row.aggregate_version), dropoffCount: input.dropoffAddresses.length};
}

export function createClientRosterReader(pool: Pool) {
  return async (input: {tenantId: string; clientId?: string; after?: string; limit: number}) =>
    withTenantTransaction(pool, input.tenantId, "kavaroutes_api", async client => {
      const rows = (await client.query(`SELECT f.id,f.display_name,f.synthetic_label,f.entity_name,f.phone,f.notes,f.trip_type,
        a.customer_label AS pickup_label,f.aggregate_version,
        coalesce(d.dropoffs,'[]'::json) AS dropoffs,coalesce(r.routes,'[]'::json) AS routes
       FROM intake.facility f
       JOIN intake.address a ON a.tenant_id=f.tenant_id AND a.id=f.address_id
       LEFT JOIN LATERAL(SELECT json_agg(json_build_object('ordinal',d.ordinal,'addressLabel',da.customer_label,
         'usageCount',d.usage_count,'lastUsedAt',d.last_used_at) ORDER BY d.usage_count DESC,d.last_used_at DESC NULLS LAST,d.ordinal) AS dropoffs
        FROM intake.client_dropoff d JOIN intake.address da ON da.tenant_id=d.tenant_id AND da.id=d.address_id
        WHERE d.tenant_id=f.tenant_id AND d.facility_id=f.id) d ON true
       LEFT JOIN LATERAL(SELECT json_agg(json_build_object('tripId',t.id,'serviceDate',t.service_date) ORDER BY t.service_date DESC,t.id) AS routes
        FROM (SELECT t.id,t.service_date FROM intake.facility_trip_scope s
         JOIN intake.trip_request t ON t.tenant_id=s.tenant_id AND t.id=s.trip_id
         WHERE s.tenant_id=f.tenant_id AND s.facility_id=f.id AND s.active
         ORDER BY t.service_date DESC,t.id LIMIT 25) t) r ON true
       WHERE f.tenant_id=$1 AND ($2::uuid IS NULL OR f.id=$2) AND ($3::uuid IS NULL OR f.id>$3)
       ORDER BY f.id LIMIT $4`, [input.tenantId, input.clientId ?? null, input.after ?? null, input.limit + 1])).rows;
      const more = rows.length > input.limit;
      const items: ClientRecordView[] = rows.slice(0, input.limit).map(row => ({
        clientId: String(row.id),
        displayName: String(row.display_name ?? row.synthetic_label),
        entityName: row.entity_name === null ? null : String(row.entity_name),
        phone: row.phone === null ? null : String(row.phone),
        pickupAddress: row.pickup_label === null ? null : String(row.pickup_label),
        dropoffAddresses: (row.dropoffs as {ordinal: number; addressLabel: string; usageCount: number; lastUsedAt: Date | string | null}[]).map(dropoff => ({
          ordinal: Number(dropoff.ordinal), addressLabel: String(dropoff.addressLabel), usageCount: Number(dropoff.usageCount),
          lastUsedAt: dropoff.lastUsedAt === null ? null : new Date(dropoff.lastUsedAt).toISOString(),
        })),
        tripType: row.trip_type === null ? null : String(row.trip_type),
        notes: row.notes === null ? null : String(row.notes),
        version: Number(row.aggregate_version),
        routes: (row.routes as {tripId: string; serviceDate: string}[]).map(route => ({tripId: String(route.tripId), serviceDate: String(route.serviceDate)})),
      }));
      return {items, nextAfter: more ? items.at(-1)!.clientId : null};
    }, "serializable");
}
export interface ClientUpdateInput {
  readonly clientId: string;
  readonly displayName: string;
  readonly entityName: string | null;
  readonly phone: string | null;
  readonly pickupAddress: string | null;
  readonly tripType: ClientTripType | null;
  readonly notes: string | null;
  /** Drop-off addresses appended after the ones already recorded. The list is the
   * pattern history and stays append-only; removing one is a dispatch retirement step,
   * not a silent edit. */
  readonly addDropoffAddresses: readonly string[];
}

/** Correct a client record: the operator fields are replaced, the pickup address label
 * is replaced, and new drop-offs are appended. The version increments so a concurrent
 * edit cannot be silently overwritten. */
export async function updateClientRecord(client: PoolClient, tenantId: string, input: ClientUpdateInput): Promise<ClientIntakeReceipt> {
  const current = (await client.query("SELECT address_id, aggregate_version FROM intake.facility WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, input.clientId])).rows[0];
  if (!current) throw new PersistenceConflict("relationship", "the client does not exist");
  await client.query(`UPDATE intake.facility SET display_name=$3, entity_name=$4, phone=$5, notes=$6, trip_type=$7,
    synthetic_label=$3, aggregate_version=aggregate_version+1 WHERE tenant_id=$1 AND id=$2`,
  [tenantId, input.clientId, input.displayName, input.entityName, input.phone, input.notes, input.tripType]);
  if (input.pickupAddress) await client.query("UPDATE intake.address SET customer_label=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, current.address_id, input.pickupAddress]);
  let appended = 0;
  if (input.addDropoffAddresses.length) {
    const highest = (await client.query("SELECT coalesce(max(ordinal),0) AS ordinal FROM intake.client_dropoff WHERE tenant_id=$1 AND facility_id=$2", [tenantId, input.clientId])).rows[0];
    let ordinal = Number(highest?.ordinal ?? 0);
    for (const label of input.addDropoffAddresses) {
      ordinal += 1;
      if (ordinal > 100) throw new PersistenceConflict("relationship", "a client can retain at most 100 drop-off addresses");
      const addressId = randomUUID();
      await client.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES($1,$2,$3)", [tenantId, addressId, label]);
      await client.query("INSERT INTO intake.client_dropoff(tenant_id,facility_id,ordinal,address_id) VALUES($1,$2,$3,$4)", [tenantId, input.clientId, ordinal, addressId]);
      appended += 1;
    }
  }
  const updated = (await client.query("SELECT aggregate_version FROM intake.facility WHERE tenant_id=$1 AND id=$2", [tenantId, input.clientId])).rows[0];
  return {clientId: input.clientId, version: Number(updated?.aggregate_version ?? 1), dropoffCount: appended};
}
