jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY",
  deleteItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-crypto", () => ({ getRandomBytesAsync: jest.fn(async () => new Uint8Array(32)) }));
jest.mock("expo-file-system", () => ({ File: jest.fn() }));
jest.mock("expo-sqlite", () => ({
  defaultDatabaseDirectory: "file:///synthetic-databases",
  deleteDatabaseAsync: jest.fn(async () => undefined),
  openDatabaseAsync: jest.fn(),
}));

import type { SQLiteDatabase } from "expo-sqlite";
import {
  createNativeDriverStore,
  type NativeDriverSessionBinding,
  type NativeDriverStoreRuntime,
  wipeNativeDriverStore,
} from "../src/storage/nativeStore";

const KEY_RECORD = "krd.binding.v2";
const LEGACY_KEY = "krd.key.v1";
const LEGACY_GENERATION = "krd.generation.v1";
const KEY = "ab".repeat(32);
const NOW = new Date("2026-09-01T12:00:00.000Z");
const binding: NativeDriverSessionBinding = Object.freeze({
  installationGeneration: "inst_0123456789abcdef",
  sessionGeneration: "sess_0123456789abcdef",
  expiresAt: "2026-09-02T12:00:00.000Z",
});

type StoredSession = {
  installation_generation: string;
  session_generation: string;
  expires_at: string;
  state: string;
};

function createHarness() {
  const secureValues = new Map<string, string>();
  const deleteFailures = new Set<string>();
  const events: string[] = [];
  const durable = {
    exists: false,
    version: 0,
    session: null as StoredSession | null,
  };

  function createDatabase(): SQLiteDatabase {
    const database = {
      execAsync: jest.fn(async (sql: string) => {
        events.push(sql.startsWith("PRAGMA key") ? "database:key" : "database:exec");
        const version = /^PRAGMA user_version = (\d+)$/.exec(sql);
        if (version) durable.version = Number(version[1]);
      }),
      getFirstAsync: jest.fn(async (sql: string) => {
        if (sql === "PRAGMA cipher_version") return { cipher_version: "4.7.0" };
        if (sql === "PRAGMA user_version") return { user_version: durable.version };
        if (sql === "PRAGMA integrity_check") return { integrity_check: "ok" };
        if (sql.includes("FROM local_session")) return durable.session ? { ...durable.session } : null;
        return null;
      }),
      runAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
        if (sql.startsWith("INSERT INTO local_session")) {
          durable.session = {
            installation_generation: String(params[0]),
            session_generation: String(params[1]),
            expires_at: String(params[2]),
            state: "ACTIVE",
          };
          events.push("session:insert");
        } else if (sql.startsWith("UPDATE local_session SET expires_at")) {
          if (durable.session) durable.session.expires_at = String(params[0]);
          events.push("session:refresh");
        } else if (sql.startsWith("UPDATE local_session SET state")) {
          if (durable.session) durable.session.state = String(params[0]);
          events.push(`session:${String(params[0]).toLowerCase()}`);
        }
        return { changes: 1, lastInsertRowId: 1 };
      }),
      withTransactionAsync: jest.fn(async (operation: () => Promise<void>) => operation()),
      closeAsync: jest.fn(async () => { events.push("database:close"); }),
    };
    return database as unknown as SQLiteDatabase;
  }

  const runtime: NativeDriverStoreRuntime = {
    now: () => NOW,
    randomBytes: jest.fn(async () => Uint8Array.from({ length: 32 }, (_, index) => index)),
    databaseArtifactsExist: jest.fn(() => durable.exists),
    openDatabase: jest.fn(async () => {
      durable.exists = true;
      events.push("database:open");
      return createDatabase();
    }),
    deleteDatabaseArtifacts: jest.fn(async () => {
      events.push("database:delete-artifacts");
      durable.exists = false;
      durable.version = 0;
      durable.session = null;
    }),
    secureStore: {
      get: jest.fn(async (reference: string) => secureValues.get(reference) ?? null),
      set: jest.fn(async (reference: string, value: string) => {
        events.push(`secure:set:${reference}`);
        secureValues.set(reference, value);
      }),
      delete: jest.fn(async (reference: string) => {
        events.push(`secure:delete:${reference}`);
        if (deleteFailures.has(reference)) throw new Error("synthetic delete failure");
        secureValues.delete(reference);
      }),
    },
  };

  return {
    deleteFailures,
    durable,
    events,
    runtime,
    secureValues,
    store: createNativeDriverStore(runtime),
  };
}

function activeRecord(installationGeneration = binding.installationGeneration) {
  return JSON.stringify({
    installationGeneration,
    keyMaterial: KEY,
    state: "ACTIVE",
    version: 2,
  });
}

describe("native Driver key and session lifecycle", () => {
  test("rejects expired bindings before reading keys or opening storage", async () => {
    const harness = createHarness();
    await expect(harness.store.open({ ...binding, expiresAt: NOW.toISOString() }))
      .rejects.toThrow("DRIVER_SESSION_EXPIRED");
    expect(harness.runtime.secureStore.get).not.toHaveBeenCalled();
    expect(harness.runtime.openDatabase).not.toHaveBeenCalled();
  });

  test("provisions one crash-recoverable key record and refreshes the same active session", async () => {
    const harness = createHarness();
    const created = await harness.store.open(binding);
    expect(created.outcome).toBe("CREATED");
    expect(harness.durable.session).toEqual({
      installation_generation: binding.installationGeneration,
      session_generation: binding.sessionGeneration,
      expires_at: binding.expiresAt,
      state: "ACTIVE",
    });
    expect(JSON.parse(harness.secureValues.get(KEY_RECORD)!)).toMatchObject({
      installationGeneration: binding.installationGeneration,
      state: "ACTIVE",
      version: 2,
    });
    expect(harness.secureValues.has(LEGACY_KEY)).toBe(false);
    expect(harness.secureValues.has(LEGACY_GENERATION)).toBe(false);

    const refreshed = { ...binding, expiresAt: "2026-09-03T12:00:00.000Z" };
    const opened = await harness.store.open(refreshed);
    expect(opened.outcome).toBe("OPENED");
    expect(harness.durable.session?.expires_at).toBe(refreshed.expiresAt);
    await expect(harness.store.assertSession(opened.database, refreshed)).resolves.toBeUndefined();
  });

  test("wipes an old session generation before allowing reprovisioning", async () => {
    const harness = createHarness();
    await harness.store.open(binding);
    await expect(harness.store.open({ ...binding, sessionGeneration: "sess_fedcba9876543210" }))
      .rejects.toThrow("DRIVER_SESSION_ROTATION_REQUIRES_REPROVISION");
    expect(harness.secureValues.size).toBe(0);
    expect(harness.durable.exists).toBe(false);

    const replacement = await harness.store.open({ ...binding, sessionGeneration: "sess_fedcba9876543210" });
    expect(replacement.outcome).toBe("CREATED");
    expect(harness.durable.session?.session_generation).toBe("sess_fedcba9876543210");
  });

  test("recovers an interrupted provisioning state by deleting partial durable artifacts", async () => {
    const harness = createHarness();
    harness.secureValues.set(KEY_RECORD, JSON.stringify({
      installationGeneration: binding.installationGeneration,
      keyMaterial: KEY,
      state: "PROVISIONING",
      version: 2,
    }));
    harness.durable.exists = true;
    harness.durable.version = 1;

    const opened = await harness.store.open(binding);
    expect(opened.outcome).toBe("CREATED");
    expect(harness.events.indexOf("database:delete-artifacts"))
      .toBeLessThan(harness.events.indexOf(`secure:set:${KEY_RECORD}`));
    expect(JSON.parse(harness.secureValues.get(KEY_RECORD)!)).toMatchObject({ state: "ACTIVE" });
  });

  test("recovers database-without-key and rejects key-without-database partial states", async () => {
    const databaseOnly = createHarness();
    databaseOnly.durable.exists = true;
    databaseOnly.durable.version = 3;
    databaseOnly.durable.session = {
      installation_generation: binding.installationGeneration,
      session_generation: binding.sessionGeneration,
      expires_at: binding.expiresAt,
      state: "ACTIVE",
    };
    const recovered = await databaseOnly.store.open(binding);
    expect(recovered.outcome).toBe("CREATED");
    expect(databaseOnly.events.indexOf("database:delete-artifacts"))
      .toBeLessThan(databaseOnly.events.indexOf("database:open"));

    const keyOnly = createHarness();
    keyOnly.secureValues.set(KEY_RECORD, activeRecord());
    await expect(keyOnly.store.open(binding)).rejects.toThrow("DRIVER_KEY_WITHOUT_DATABASE");
    expect(keyOnly.secureValues.size).toBe(0);
    expect(keyOnly.runtime.openDatabase).not.toHaveBeenCalled();
  });

  test("fails closed on partial legacy metadata and migrates a complete legacy binding", async () => {
    const orphaned = createHarness();
    orphaned.secureValues.set(LEGACY_KEY, KEY);
    await expect(orphaned.store.open(binding)).rejects.toThrow("DRIVER_KEY_BINDING_ORPHANED");
    expect(orphaned.secureValues.size).toBe(0);
    expect(orphaned.events).toContain("database:delete-artifacts");

    const legacy = createHarness();
    legacy.secureValues.set(LEGACY_KEY, KEY);
    legacy.secureValues.set(LEGACY_GENERATION, binding.installationGeneration);
    legacy.durable.exists = true;
    legacy.durable.version = 3;
    legacy.durable.session = {
      installation_generation: binding.installationGeneration,
      session_generation: binding.sessionGeneration,
      expires_at: binding.expiresAt,
      state: "ACTIVE",
    };
    const opened = await legacy.store.open(binding);
    expect(opened.outcome).toBe("OPENED");
    expect(JSON.parse(legacy.secureValues.get(KEY_RECORD)!)).toMatchObject({ state: "ACTIVE" });
    expect(legacy.secureValues.has(LEGACY_KEY)).toBe(false);
    expect(legacy.secureValues.has(LEGACY_GENERATION)).toBe(false);
  });

  test.each(["LOGGED_OUT", "REVOKED"] as const)(
    "marks %s best-effort, then closes, removes every key, and deletes all database artifacts",
    async (state) => {
      const harness = createHarness();
      const opened = await harness.store.open(binding);
      harness.events.length = 0;
      await harness.store.invalidateSession(opened.database, state);
      expect(harness.events).toEqual([
        `session:${state.toLowerCase()}`,
        "database:close",
        `secure:delete:${KEY_RECORD}`,
        `secure:delete:${LEGACY_KEY}`,
        `secure:delete:${LEGACY_GENERATION}`,
        "database:delete-artifacts",
      ]);
      expect(harness.secureValues.size).toBe(0);
      expect(harness.durable.exists).toBe(false);
    },
  );

  test("attempts the complete wipe when close or an individual key deletion fails", async () => {
    const harness = createHarness();
    harness.secureValues.set(KEY_RECORD, activeRecord());
    harness.secureValues.set(LEGACY_KEY, KEY);
    harness.secureValues.set(LEGACY_GENERATION, binding.installationGeneration);
    harness.deleteFailures.add(KEY_RECORD);
    const database = {
      closeAsync: jest.fn(async () => { harness.events.push("database:close"); throw new Error("close failed"); }),
    } as unknown as SQLiteDatabase;

    await expect(harness.store.wipe(database)).rejects.toThrow("DRIVER_STORE_WIPE_INCOMPLETE");
    expect(harness.events).toContain(`secure:delete:${LEGACY_KEY}`);
    expect(harness.events).toContain(`secure:delete:${LEGACY_GENERATION}`);
    expect(harness.events).toContain("database:delete-artifacts");
  });

  test("supplements Expo database deletion with journal and WAL sidecar removal", async () => {
    const sqlite = jest.requireMock("expo-sqlite") as { deleteDatabaseAsync: jest.Mock };
    const fileSystem = jest.requireMock("expo-file-system") as { File: jest.Mock };
    const deleted: string[] = [];
    fileSystem.File.mockImplementation((_directory: string, name: string) => ({
      delete: () => { deleted.push(name); },
      exists: name !== "krd.sqlite",
    }));

    await wipeNativeDriverStore();
    expect(sqlite.deleteDatabaseAsync).toHaveBeenCalledWith("krd.sqlite");
    expect(deleted).toEqual(["krd.sqlite-journal", "krd.sqlite-wal", "krd.sqlite-shm"]);
  });

  test("falls back to explicit main and sidecar removal when Expo deletion fails", async () => {
    const sqlite = jest.requireMock("expo-sqlite") as { deleteDatabaseAsync: jest.Mock };
    const fileSystem = jest.requireMock("expo-file-system") as { File: jest.Mock };
    const deleted: string[] = [];
    sqlite.deleteDatabaseAsync.mockRejectedValueOnce(new Error("synthetic native delete failure"));
    fileSystem.File.mockImplementation((_directory: string, name: string) => ({
      delete: () => { deleted.push(name); },
      exists: true,
    }));

    await wipeNativeDriverStore();
    expect(deleted).toEqual(["krd.sqlite", "krd.sqlite-journal", "krd.sqlite-wal", "krd.sqlite-shm"]);
  });
});
