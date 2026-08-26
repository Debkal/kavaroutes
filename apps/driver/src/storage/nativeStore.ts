import * as SecureStore from "expo-secure-store";
import { getRandomBytesAsync } from "expo-crypto";
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { DRIVER_MIGRATIONS } from "@kavaroutes/driver-core/migrations";

const DATABASE_NAME = "krd.sqlite";
const KEY_REFERENCE = "krd.key.v1";
const GENERATION_REFERENCE = "krd.generation.v1";
const keyOptions = Object.freeze({ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
const toHex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
const assertKey = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("DRIVER_DATABASE_KEY_INVALID"); return value; };

async function applyKey(database: SQLiteDatabase, key: string): Promise<void> {
  await database.execAsync(`PRAGMA key = "x'${assertKey(key)}'";`);
  const cipher = await database.getFirstAsync<{ readonly cipher_version: string }>("PRAGMA cipher_version");
  if (!cipher?.cipher_version) throw new Error("SQLCIPHER_UNAVAILABLE");
}

export async function openNativeDriverStore(binding: { readonly installationGeneration: string; readonly sessionGeneration: string; readonly expiresAt: string }): Promise<{ readonly database: SQLiteDatabase; readonly outcome: "CREATED" | "OPENED" }> {
  if (!/^inst_[a-z0-9]{16,64}$/.test(binding.installationGeneration)) throw new Error("INSTALLATION_GENERATION_INVALID");
  if (!/^sess_[a-z0-9]{16,64}$/.test(binding.sessionGeneration) || !Number.isFinite(Date.parse(binding.expiresAt))) throw new Error("SESSION_BINDING_INVALID");
  const existingKey = await SecureStore.getItemAsync(KEY_REFERENCE, keyOptions);
  const existingGeneration = await SecureStore.getItemAsync(GENERATION_REFERENCE, keyOptions);
  if ((existingKey === null) !== (existingGeneration === null) || (existingGeneration !== null && existingGeneration !== binding.installationGeneration)) {
    await SecureStore.deleteItemAsync(KEY_REFERENCE, keyOptions); await SecureStore.deleteItemAsync(GENERATION_REFERENCE, keyOptions);
    throw new Error("DRIVER_KEY_BINDING_ORPHANED");
  }
  const key = existingKey ?? toHex(await getRandomBytesAsync(32));
  const database = await openDatabaseAsync(DATABASE_NAME);
  await applyKey(database, key);
  const version = await database.getFirstAsync<{ readonly user_version: number }>("PRAGMA user_version");
  const created = (version?.user_version ?? 0) === 0;
  if (created && existingKey !== null) { await database.closeAsync(); throw new Error("DRIVER_KEY_WITHOUT_DATABASE"); }
  try {
    await database.withTransactionAsync(async () => {
      for (const migration of DRIVER_MIGRATIONS) if (migration.version > (version?.user_version ?? 0)) { await database.execAsync(migration.sql); await database.execAsync(`PRAGMA user_version = ${migration.version}`); }
      const integrity = await database.getFirstAsync<{ readonly integrity_check: string }>("PRAGMA integrity_check");
      if (integrity?.integrity_check !== "ok") throw new Error("DRIVER_DATABASE_INTEGRITY_FAILED");
      const stored = await database.getFirstAsync<{ readonly installation_generation: string }>("SELECT installation_generation FROM local_session WHERE id=1");
      if (stored && stored.installation_generation !== binding.installationGeneration) throw new Error("DRIVER_DATABASE_BINDING_MISMATCH");
      if (!stored) await database.runAsync("INSERT INTO local_session (id,installation_generation,session_generation,expires_at,state) VALUES (1,?,?,?,'ACTIVE')",
        binding.installationGeneration, binding.sessionGeneration, binding.expiresAt);
    });
    if (existingKey === null) { await SecureStore.setItemAsync(KEY_REFERENCE, key, keyOptions); await SecureStore.setItemAsync(GENERATION_REFERENCE, binding.installationGeneration, keyOptions); }
    return Object.freeze({ database, outcome: created ? "CREATED" : "OPENED" });
  } catch (error) { await database.closeAsync(); throw error; }
}

export async function removeNativeDriverKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_REFERENCE, keyOptions); await SecureStore.deleteItemAsync(GENERATION_REFERENCE, keyOptions);
}

export async function saveNativeProjection(database: SQLiteDatabase, input: { readonly version: number; readonly encryptedProjection: Uint8Array; readonly projectionReference: string; readonly encryptedCursor: Uint8Array; readonly appliedAt: string }): Promise<void> {
  await database.withTransactionAsync(async () => {
    await database.runAsync("INSERT INTO manifest_snapshot (id,version,encrypted_projection,applied_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,encrypted_projection=excluded.encrypted_projection,applied_at=excluded.applied_at",
      input.version, input.encryptedProjection, input.appliedAt);
    await database.runAsync("INSERT INTO sync_cursor (projection_reference,encrypted_cursor,applied_at) VALUES (?,?,?) ON CONFLICT(projection_reference) DO UPDATE SET encrypted_cursor=excluded.encrypted_cursor,applied_at=excluded.applied_at",
      input.projectionReference, input.encryptedCursor, input.appliedAt);
  });
}

export async function wipeNativeDriverStore(database?: SQLiteDatabase): Promise<void> {
  if (database) await database.closeAsync();
  await deleteDatabaseAsync(DATABASE_NAME);
  await removeNativeDriverKey();
}
