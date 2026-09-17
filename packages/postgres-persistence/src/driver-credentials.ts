import {createHash,randomBytes,scryptSync,timingSafeEqual} from "node:crypto";
import type {PoolClient} from "pg";
import {PersistenceConflict} from "./repositories.js";

/**
 * Driver logins for the synthetic prototype. Dispatch issues the login and the driver
 * sets their own password the first time they claim it on their designated phone, so
 * each driver keeps a separate credential. Only a scrypt digest and a SHA-256 hash of
 * the one-time invite code are stored; the invite code is cleared on claim.
 */
export const SCRYPT_PARAMETERS = Object.freeze({N: 16384, r: 8, p: 1, keyLength: 64});
const MAX_FAILED_ATTEMPTS = 5, LOCK_MINUTES = 15;

export interface DriverCredentialInvite {
  readonly driverId: string;
  readonly loginId: string;
  readonly inviteCode: string;
  readonly status: "INVITED";
  /** The credential's aggregate version; the audit row records it, so a re-invite is a
   * new version of the same login rather than a collision (audit WEB-A-024). */
  readonly version: number;
}
export interface DriverCredentialState {
  readonly driverId: string;
  readonly loginId: string;
  readonly status: string;
  readonly claimedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly version: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function hashDriverPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const {N, r, p, keyLength} = SCRYPT_PARAMETERS;
  const derived = scryptSync(password, salt, keyLength, {N, r, p, maxmem: 64 * 1024 * 1024}).toString("hex");
  return {value: `scrypt$${salt}$${N}$${r}$${p}$${derived}`, parameters: {N, r, p, keyLength}};
}
export function verifyDriverPassword(password: string, stored: string) {
  const [scheme, salt, n, r, p, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !n || !r || !p || !expected) return false;
  const derived = scryptSync(password, salt, expected.length / 2, {N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024});
  return derived.length === expected.length / 2 && timingSafeEqual(derived, Buffer.from(expected, "hex"));
}
/** Invite codes are handed over once; only their hash is persisted. */
const newInviteCode = () => randomBytes(9).toString("base64url").replaceAll("-", "A").replaceAll("_", "B");

export async function createDriverCredential(client: PoolClient, tenantId: string, input: {driverId: string; loginId: string}): Promise<DriverCredentialInvite> {
  const driver = (await client.query("SELECT id FROM fleet.driver WHERE tenant_id=$1 AND id=$2", [tenantId, input.driverId])).rows[0];
  if (!driver) throw new PersistenceConflict("relationship", "the driver does not exist");
  const inviteCode = newInviteCode();
  // Re-inviting an existing login is a deliberate lifecycle step (lost code, password
  // reset): it replaces the code, clears any password and lock, and bumps the version
  // so the audit trail stays append-only.
  const row = (await client.query(`INSERT INTO platform.driver_credential(tenant_id,driver_id,login_id,status,invite_code_hash)
    VALUES($1,$2,$3,'INVITED',$4)
    ON CONFLICT (tenant_id,driver_id) DO UPDATE SET login_id=EXCLUDED.login_id, invite_code_hash=EXCLUDED.invite_code_hash,
      status='INVITED', password_hash=NULL, password_parameters=NULL, claimed_at=NULL, claimed_installation=NULL,
      failed_attempts=0, locked_until=NULL, invited_at=now(), credential_version=platform.driver_credential.credential_version+1
    RETURNING credential_version`,
  [tenantId, input.driverId, input.loginId, digest(inviteCode)])).rows[0];
  if (!row) throw new PersistenceConflict("relationship", "the driver login could not be recorded");
  return {driverId: input.driverId, loginId: input.loginId, inviteCode, status: "INVITED", version: Number(row.credential_version)};
}

export async function claimDriverCredential(client: PoolClient, tenantId: string, input: {driverId: string; inviteCode: string;
  password: string; installation?: string}): Promise<DriverCredentialState> {
  const row = (await client.query(`SELECT login_id,status,invite_code_hash,claimed_at,last_login_at FROM platform.driver_credential
    WHERE tenant_id=$1 AND driver_id=$2 FOR UPDATE`, [tenantId, input.driverId])).rows[0];
  if (!row || row.status !== "INVITED" || !row.invite_code_hash) throw new PersistenceConflict("relationship", "no invited driver login is waiting");
  if (!timingSafeEqual(Buffer.from(digest(input.inviteCode), "hex"), Buffer.from(String(row.invite_code_hash), "hex"))) {
    throw new PersistenceConflict("relationship", "the invite code does not match");
  }
  const password = hashDriverPassword(input.password);
  const updated = (await client.query(`UPDATE platform.driver_credential
    SET status='ACTIVE', password_hash=$3, password_parameters=$4::jsonb, invite_code_hash=NULL, claimed_at=now(),
      claimed_installation=$5, failed_attempts=0, locked_until=NULL, credential_version=credential_version+1
    WHERE tenant_id=$1 AND driver_id=$2 RETURNING login_id,status,claimed_at,last_login_at,credential_version`,
  [tenantId, input.driverId, password.value, JSON.stringify(password.parameters), input.installation ?? null])).rows[0];
  if (!updated) throw new PersistenceConflict("relationship", "the driver login could not be claimed");
  return {driverId: input.driverId, loginId: String(updated.login_id), status: String(updated.status),
    claimedAt: updated.claimed_at ? new Date(updated.claimed_at).toISOString() : null,
    lastLoginAt: updated.last_login_at ? new Date(updated.last_login_at).toISOString() : null,
    version: Number(updated.credential_version)};
}

/**
 * Verify a driver password. A rejection is a *result*, not a thrown error: the
 * failed-attempt counter and the lockout have to commit, which they cannot do if the
 * caller rolls the transaction back on an exception.
 */
export interface DriverLoginAttempt {
  readonly accepted: boolean;
  readonly reason: "NO_LOGIN" | "LOCKED" | "NOT_CLAIMED" | "BAD_PASSWORD" | null;
  readonly state: DriverCredentialState | null;
}
export async function verifyDriverLogin(client: PoolClient, tenantId: string, input: {loginId: string; password: string}): Promise<DriverLoginAttempt> {
  const row = (await client.query(`SELECT driver_id,login_id,status,password_hash,claimed_at,last_login_at,failed_attempts,locked_until,credential_version
    FROM platform.driver_credential WHERE tenant_id=$1 AND login_id=$2 FOR UPDATE`, [tenantId, input.loginId])).rows[0];
  if (!row) return {accepted: false, reason: "NO_LOGIN", state: null};
  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return {accepted: false, reason: "LOCKED", state: null};
  if (row.status !== "ACTIVE" || !row.password_hash) return {accepted: false, reason: "NOT_CLAIMED", state: null};
  if (!verifyDriverPassword(input.password, String(row.password_hash))) {
    // Count the attempt and lock in SQL only: no CASE over a driver-supplied value and
    // no interval built from a parameter, so the statement cannot fail its own CHECK.
    const updated = (await client.query(`UPDATE platform.driver_credential
      SET failed_attempts = failed_attempts + 1,
          status = CASE WHEN failed_attempts + 1 >= $3 THEN 'LOCKED' ELSE status END,
          locked_until = CASE WHEN failed_attempts + 1 >= $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
      WHERE tenant_id=$1 AND driver_id=$2
      RETURNING failed_attempts, status`, [tenantId, row.driver_id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES])).rows[0];
    const locked = String(updated?.status) === "LOCKED";
    return {accepted: false, reason: locked ? "LOCKED" : "BAD_PASSWORD", state: null};
  }
  const updated = (await client.query(`UPDATE platform.driver_credential SET failed_attempts=0, locked_until=NULL, last_login_at=now(),
    credential_version=credential_version+1 WHERE tenant_id=$1 AND driver_id=$2
    RETURNING login_id,status,claimed_at,last_login_at,credential_version`, [tenantId, row.driver_id])).rows[0];
  return {accepted: true, reason: null, state: {driverId: String(row.driver_id), loginId: String(updated.login_id),
    status: String(updated.status), claimedAt: updated.claimed_at ? new Date(updated.claimed_at).toISOString() : null,
    lastLoginAt: updated.last_login_at ? new Date(updated.last_login_at).toISOString() : null,
    version: Number(updated.credential_version)}};
}
