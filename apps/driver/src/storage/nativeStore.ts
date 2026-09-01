import * as SecureStore from "expo-secure-store";
import { getRandomBytesAsync } from "expo-crypto";
import { File } from "expo-file-system";
import {
  defaultDatabaseDirectory,
  deleteDatabaseAsync,
  openDatabaseAsync,
  type SQLiteDatabase,
} from "expo-sqlite";
import { DRIVER_MIGRATIONS } from "@kavaroutes/driver-core/migrations";

const DATABASE_NAME = "krd.sqlite";
const KEY_RECORD_REFERENCE = "krd.binding.v2";
const LEGACY_KEY_REFERENCE = "krd.key.v1";
const LEGACY_GENERATION_REFERENCE = "krd.generation.v1";
const DATABASE_SIDECARS = ["-journal", "-wal", "-shm"] as const;
const DATABASE_ARTIFACT_SUFFIXES = ["", ...DATABASE_SIDECARS] as const;
const keyOptions = Object.freeze({ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
const installationPattern = /^inst_[a-z0-9]{16,64}$/;
const sessionPattern = /^sess_[a-z0-9]{16,64}$/;
const keyPattern = /^[a-f0-9]{64}$/;

export type NativeDriverSessionBinding = Readonly<{
  installationGeneration: string;
  sessionGeneration: string;
  expiresAt: string;
}>;

type DriverKeyRecord = Readonly<{
  version: 2;
  state: "PROVISIONING" | "ACTIVE";
  keyMaterial: string;
  installationGeneration: string;
}>;

type StoredSession = Readonly<{
  installation_generation: string;
  session_generation: string;
  expires_at: string;
  state: string;
}>;

export type NativeDriverStoreRuntime = Readonly<{
  now(): Date;
  randomBytes(length: number): Promise<Uint8Array>;
  databaseArtifactsExist(): boolean;
  openDatabase(): Promise<SQLiteDatabase>;
  deleteDatabaseArtifacts(): Promise<void>;
  secureStore: Readonly<{
    get(reference: string): Promise<string | null>;
    set(reference: string, value: string): Promise<void>;
    delete(reference: string): Promise<void>;
  }>;
}>;

const toHex = (bytes: Uint8Array) => [...bytes]
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("");

function assertKey(value: string): string {
  if (!keyPattern.test(value)) throw new Error("DRIVER_DATABASE_KEY_INVALID");
  return value;
}

export function validateNativeDriverSessionBinding(
  binding: NativeDriverSessionBinding,
  now = new Date(),
): void {
  if (!installationPattern.test(binding.installationGeneration)) {
    throw new Error("INSTALLATION_GENERATION_INVALID");
  }
  if (!sessionPattern.test(binding.sessionGeneration)) throw new Error("SESSION_BINDING_INVALID");
  const expiresAt = Date.parse(binding.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("SESSION_BINDING_INVALID");
  if (expiresAt <= now.getTime()) throw new Error("DRIVER_SESSION_EXPIRED");
}

function parseKeyRecord(serialized: string): DriverKeyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("DRIVER_KEY_RECORD_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DRIVER_KEY_RECORD_INVALID");
  }
  const candidate = parsed as Record<string, unknown>;
  const expected = ["installationGeneration", "keyMaterial", "state", "version"];
  if (Object.keys(candidate).sort().join(",") !== expected.join(",")
    || candidate.version !== 2
    || (candidate.state !== "PROVISIONING" && candidate.state !== "ACTIVE")
    || typeof candidate.keyMaterial !== "string"
    || !keyPattern.test(candidate.keyMaterial)
    || typeof candidate.installationGeneration !== "string"
    || !installationPattern.test(candidate.installationGeneration)) {
    throw new Error("DRIVER_KEY_RECORD_INVALID");
  }
  return candidate as DriverKeyRecord;
}

async function applyKey(database: SQLiteDatabase, key: string): Promise<void> {
  await database.execAsync(`PRAGMA key = "x'${assertKey(key)}'";`);
  const cipher = await database.getFirstAsync<{ readonly cipher_version: string }>("PRAGMA cipher_version");
  if (!cipher?.cipher_version) throw new Error("SQLCIPHER_UNAVAILABLE");
}

async function deleteDefaultDatabaseArtifacts(): Promise<void> {
  let failed = false;
  try {
    await deleteDatabaseAsync(DATABASE_NAME);
  } catch {
    // Explicit file removal below is the fallback for not-found and native cache/delete failures.
  }
  for (const suffix of DATABASE_ARTIFACT_SUFFIXES) {
    try {
      const file = new File(defaultDatabaseDirectory, `${DATABASE_NAME}${suffix}`);
      if (file.exists) file.delete();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("DRIVER_DATABASE_ARTIFACT_DELETE_FAILED");
}

const defaultRuntime: NativeDriverStoreRuntime = Object.freeze({
  now: () => new Date(),
  randomBytes: (length) => getRandomBytesAsync(length),
  databaseArtifactsExist: () => DATABASE_ARTIFACT_SUFFIXES.some((suffix) =>
    new File(defaultDatabaseDirectory, `${DATABASE_NAME}${suffix}`).exists),
  openDatabase: () => openDatabaseAsync(DATABASE_NAME, { useNewConnection: true }),
  deleteDatabaseArtifacts: deleteDefaultDatabaseArtifacts,
  secureStore: Object.freeze({
    get: (reference: string) => SecureStore.getItemAsync(reference, keyOptions),
    set: (reference: string, value: string) => SecureStore.setItemAsync(reference, value, keyOptions),
    delete: (reference: string) => SecureStore.deleteItemAsync(reference, keyOptions),
  }),
});

export function createNativeDriverStore(runtime: NativeDriverStoreRuntime) {
  async function removeKeys(): Promise<void> {
    let failed = false;
    for (const reference of [KEY_RECORD_REFERENCE, LEGACY_KEY_REFERENCE, LEGACY_GENERATION_REFERENCE]) {
      try {
        await runtime.secureStore.delete(reference);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("DRIVER_KEY_DELETE_FAILED");
  }

  async function wipe(database?: SQLiteDatabase): Promise<void> {
    let failed = false;
    if (database) {
      try {
        await database.closeAsync();
      } catch {
        failed = true;
      }
    }
    try {
      await removeKeys();
    } catch {
      failed = true;
    }
    try {
      await runtime.deleteDatabaseArtifacts();
    } catch {
      failed = true;
    }
    if (failed) throw new Error("DRIVER_STORE_WIPE_INCOMPLETE");
  }

  async function recover(error: unknown, database?: SQLiteDatabase): Promise<never> {
    try {
      await wipe(database);
    } catch {
      throw new Error("DRIVER_STORE_RECOVERY_FAILED");
    }
    throw error;
  }

  async function readKeyRecord(): Promise<{ record: DriverKeyRecord | null; legacy: boolean }> {
    const [serialized, legacyKey, legacyGeneration] = await Promise.all([
      runtime.secureStore.get(KEY_RECORD_REFERENCE),
      runtime.secureStore.get(LEGACY_KEY_REFERENCE),
      runtime.secureStore.get(LEGACY_GENERATION_REFERENCE),
    ]);
    if (serialized !== null) {
      return { record: parseKeyRecord(serialized), legacy: legacyKey !== null || legacyGeneration !== null };
    }
    if ((legacyKey === null) !== (legacyGeneration === null)) throw new Error("DRIVER_KEY_BINDING_ORPHANED");
    if (legacyKey === null || legacyGeneration === null) return { record: null, legacy: false };
    return {
      legacy: true,
      record: Object.freeze({
        version: 2,
        state: "ACTIVE",
        keyMaterial: assertKey(legacyKey),
        installationGeneration: legacyGeneration,
      }),
    };
  }

  async function open(binding: NativeDriverSessionBinding): Promise<{
    readonly database: SQLiteDatabase;
    readonly outcome: "CREATED" | "OPENED";
  }> {
    validateNativeDriverSessionBinding(binding, runtime.now());

    let keyState: { record: DriverKeyRecord | null; legacy: boolean };
    try {
      keyState = await readKeyRecord();
    } catch (error) {
      return recover(error);
    }
    if (keyState.record?.state === "PROVISIONING") {
      await wipe();
      keyState = { record: null, legacy: false };
    }
    let artifactsExist: boolean;
    try {
      artifactsExist = runtime.databaseArtifactsExist();
    } catch (error) {
      return recover(error);
    }
    if (keyState.record && keyState.record.installationGeneration !== binding.installationGeneration) {
      return recover(new Error("DRIVER_INSTALLATION_ROTATION_REQUIRES_REPROVISION"));
    }
    if (keyState.record && !artifactsExist) {
      return recover(new Error("DRIVER_KEY_WITHOUT_DATABASE"));
    }
    if (!keyState.record && artifactsExist) await wipe();

    let record = keyState.record;
    const provisioning = record === null;
    if (!record) {
      const keyMaterial = toHex(await runtime.randomBytes(32));
      record = Object.freeze({
        version: 2,
        state: "PROVISIONING",
        keyMaterial: assertKey(keyMaterial),
        installationGeneration: binding.installationGeneration,
      });
      try {
        await runtime.secureStore.set(KEY_RECORD_REFERENCE, JSON.stringify(record));
      } catch (error) {
        return recover(error);
      }
    }

    let database: SQLiteDatabase | undefined;
    try {
      const activeDatabase = await runtime.openDatabase();
      database = activeDatabase;
      await applyKey(activeDatabase, record.keyMaterial);
      const version = await activeDatabase.getFirstAsync<{ readonly user_version: number }>("PRAGMA user_version");
      const created = (version?.user_version ?? 0) === 0;
      if (created && !provisioning) throw new Error("DRIVER_KEY_WITHOUT_DATABASE");

      await activeDatabase.withTransactionAsync(async () => {
        for (const migration of DRIVER_MIGRATIONS) {
          if (migration.version > (version?.user_version ?? 0)) {
            await activeDatabase.execAsync(migration.sql);
            await activeDatabase.execAsync(`PRAGMA user_version = ${migration.version}`);
          }
        }
        const integrity = await activeDatabase.getFirstAsync<{ readonly integrity_check: string }>("PRAGMA integrity_check");
        if (integrity?.integrity_check !== "ok") throw new Error("DRIVER_DATABASE_INTEGRITY_FAILED");
        const stored = await activeDatabase.getFirstAsync<StoredSession>(
          "SELECT installation_generation,session_generation,expires_at,state FROM local_session WHERE id=1",
        );
        if (!stored) {
          if (!provisioning) throw new Error("DRIVER_SESSION_RECORD_MISSING");
          await activeDatabase.runAsync(
            "INSERT INTO local_session (id,installation_generation,session_generation,expires_at,state) VALUES (1,?,?,?,'ACTIVE')",
            binding.installationGeneration,
            binding.sessionGeneration,
            binding.expiresAt,
          );
          return;
        }
        if (stored.installation_generation !== binding.installationGeneration) {
          throw new Error("DRIVER_DATABASE_BINDING_MISMATCH");
        }
        if (stored.state !== "ACTIVE") throw new Error("DRIVER_SESSION_NOT_ACTIVE");
        if (stored.session_generation !== binding.sessionGeneration) {
          throw new Error("DRIVER_SESSION_ROTATION_REQUIRES_REPROVISION");
        }
        if (!Number.isFinite(Date.parse(stored.expires_at))) throw new Error("DRIVER_SESSION_RECORD_INVALID");
        if (stored.expires_at !== binding.expiresAt) {
          await activeDatabase.runAsync("UPDATE local_session SET expires_at=? WHERE id=1", binding.expiresAt);
        }
      });

      if (provisioning || keyState.legacy) {
        const activeRecord: DriverKeyRecord = Object.freeze({ ...record, state: "ACTIVE" });
        await runtime.secureStore.set(KEY_RECORD_REFERENCE, JSON.stringify(activeRecord));
      }
      if (keyState.legacy) {
        await runtime.secureStore.delete(LEGACY_KEY_REFERENCE);
        await runtime.secureStore.delete(LEGACY_GENERATION_REFERENCE);
      }
      return Object.freeze({ database: activeDatabase, outcome: provisioning ? "CREATED" : "OPENED" });
    } catch (error) {
      return recover(error, database);
    }
  }

  async function assertSession(database: SQLiteDatabase, binding: NativeDriverSessionBinding): Promise<void> {
    validateNativeDriverSessionBinding(binding, runtime.now());
    const stored = await database.getFirstAsync<StoredSession>(
      "SELECT installation_generation,session_generation,expires_at,state FROM local_session WHERE id=1",
    );
    if (!stored
      || stored.installation_generation !== binding.installationGeneration
      || stored.session_generation !== binding.sessionGeneration
      || stored.expires_at !== binding.expiresAt
      || stored.state !== "ACTIVE") {
      throw new Error("DRIVER_ACTIVE_SESSION_MISMATCH");
    }
  }

  async function invalidateSession(database: SQLiteDatabase | undefined, state: "LOGGED_OUT" | "REVOKED"): Promise<void> {
    if (database) {
      try {
        await database.withTransactionAsync(async () => {
          await database.runAsync("UPDATE local_session SET state=? WHERE id=1", state);
        });
      } catch {
        // The durable wipe is authoritative; a best-effort marker must never prevent it.
      }
    }
    await wipe(database);
  }

  return Object.freeze({ open, assertSession, invalidateSession, removeKeys, wipe });
}

const nativeDriverStore = createNativeDriverStore(defaultRuntime);

export const openNativeDriverStore = nativeDriverStore.open;
export const assertNativeDriverSession = nativeDriverStore.assertSession;
export const invalidateNativeDriverSession = nativeDriverStore.invalidateSession;
export const removeNativeDriverKey = nativeDriverStore.removeKeys;
export const wipeNativeDriverStore = nativeDriverStore.wipe;

export async function saveNativeProjection(database: SQLiteDatabase, input: {
  readonly version: number;
  readonly encryptedProjection: Uint8Array;
  readonly projectionReference: string;
  readonly encryptedCursor: Uint8Array;
  readonly appliedAt: string;
}): Promise<void> {
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      "INSERT INTO manifest_snapshot (id,version,encrypted_projection,applied_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,encrypted_projection=excluded.encrypted_projection,applied_at=excluded.applied_at",
      input.version,
      input.encryptedProjection,
      input.appliedAt,
    );
    await database.runAsync(
      "INSERT INTO sync_cursor (projection_reference,encrypted_cursor,applied_at) VALUES (?,?,?) ON CONFLICT(projection_reference) DO UPDATE SET encrypted_cursor=excluded.encrypted_cursor,applied_at=excluded.applied_at",
      input.projectionReference,
      input.encryptedCursor,
      input.appliedAt,
    );
  });
}
