import { Linking, Platform } from "react-native";
import * as Location from "expo-location";
import type { SQLiteDatabase } from "expo-sqlite";
import { DEFAULT_SAMPLING_POLICY, handoffNavigation, type DriverLocationSample, type VehicleMotionState, updateVehicleMotion } from "@kavaroutes/driver-core";
import { createActionFingerprint, createEvidenceDigest, createPolicyDigest } from "./crypto";
import { configureBackgroundLocation, DRIVER_LOCATION_TASK } from "./background-location";
import {
  assertNativeDriverSession,
  invalidateNativeDriverSession,
  openNativeDriverStore,
  wipeNativeDriverStore,
} from "./storage/nativeStore";
import { createSyntheticWorkflow, restoreSyntheticWorkflow, type SyntheticWorkflow } from "@kavaroutes/driver-core";

const INSTALLATION_GENERATION = "inst_synthetic0000001";
const SESSION_GENERATION = "sess_synthetic0000001";
const SYNTHETIC_SESSION_BINDING = Object.freeze({
  installationGeneration: INSTALLATION_GENERATION,
  sessionGeneration: SESSION_GENERATION,
  expiresAt: "2027-08-26T00:00:00.000Z",
});
const SYNTHETIC_RESOURCE = "33333333-3333-4333-8333-333333333332";
const SYNTHETIC_ACTION = "33333333-3333-4333-8333-333333333331";
const encode = (value: string) => new TextEncoder().encode(value);
let databasePromise: Promise<SQLiteDatabase> | undefined;

async function database(): Promise<SQLiteDatabase> {
  databasePromise ??= openNativeDriverStore(SYNTHETIC_SESSION_BINDING).then((result) => result.database);
  let activeDatabase: SQLiteDatabase;
  try {
    activeDatabase = await databasePromise;
  } catch (error) {
    databasePromise = undefined;
    throw error;
  }
  try {
    await assertNativeDriverSession(activeDatabase, SYNTHETIC_SESSION_BINDING);
    return activeDatabase;
  } catch (error) {
    databasePromise = undefined;
    try {
      await wipeNativeDriverStore(activeDatabase);
    } catch {
      throw new Error("DRIVER_STORE_RECOVERY_FAILED");
    }
    throw error;
  }
}

export async function loadSyntheticWorkflow(): Promise<SyntheticWorkflow> {
  const db = await database();
  const row = await db.getFirstAsync<{ readonly encrypted_state: Uint8Array | string; readonly policy_digest: string | null }>("SELECT encrypted_state,policy_digest FROM workflow_checkpoint WHERE id=1");
  if (!row) return createSyntheticWorkflow();
  const raw = typeof row.encrypted_state === "string" ? row.encrypted_state : new TextDecoder().decode(row.encrypted_state);
  const parsed = restoreSyntheticWorkflow(JSON.parse(raw));
  if (row.policy_digest && parsed.effectivePolicy?.canonicalDigest !== row.policy_digest) throw new Error("WORKFLOW_POLICY_BINDING_INVALID");
  if (parsed.effectivePolicy && await createPolicyDigest(parsed.effectivePolicy) !== parsed.effectivePolicy.canonicalDigest) throw new Error("WORKFLOW_POLICY_CONTENT_INVALID");
  return parsed;
}

export async function saveSyntheticWorkflow(state: SyntheticWorkflow): Promise<void> {
  const db = await database();
  if (state.effectivePolicy && await createPolicyDigest(state.effectivePolicy) !== state.effectivePolicy.canonicalDigest) throw new Error("WORKFLOW_POLICY_CONTENT_INVALID");
  await db.runAsync(`INSERT INTO workflow_checkpoint (id,version,encrypted_state,updated_at,policy_digest) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,encrypted_state=excluded.encrypted_state,updated_at=excluded.updated_at,policy_digest=excluded.policy_digest`,
    state.authoritativeVersion, encode(JSON.stringify(state)), new Date().toISOString(), state.effectivePolicy?.canonicalDigest ?? null);
}

export async function resetSyntheticWorkflow(): Promise<void> {
  let locationStopFailed = false;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    }
  } catch {
    locationStopFailed = true;
  }
  const pendingDatabase = databasePromise;
  databasePromise = undefined;
  let activeDatabase: SQLiteDatabase | undefined;
  try {
    activeDatabase = await pendingDatabase;
  } catch {
    // A failed open is still followed by key and database artifact removal.
  }
  await invalidateNativeDriverSession(activeDatabase, "LOGGED_OUT");
  if (locationStopFailed) throw new Error("DRIVER_LOCATION_STOP_FAILED");
}

export async function queueSyntheticArrival(): Promise<"QUEUED" | "ALREADY_QUEUED"> {
  const db = await database();
  const existing = await db.getFirstAsync<{ readonly state: string }>("SELECT state FROM client_action WHERE action_id=?", SYNTHETIC_ACTION);
  if (existing) return "ALREADY_QUEUED";
  const capturedAt = new Date().toISOString();
  const fingerprint = await createActionFingerprint({ resourceReference: SYNTHETIC_RESOURCE, expectedVersion: 1, causalSequence: 1, command: "ARRIVE_PICKUP" });
  await db.runAsync(`INSERT INTO client_action
    (action_id,idempotency_key,fingerprint,resource_reference,expected_version,causal_sequence,command,encrypted_payload,state,attempt,next_attempt_at)
    VALUES (?,?,?,?,?,?,?,?,'PENDING',0,?)`, SYNTHETIC_ACTION, "idem_synthetic_0000000001", fingerprint, SYNTHETIC_RESOURCE, 1, 1,
    "ARRIVE_PICKUP", encode(JSON.stringify({ kind: "SYNTHETIC_ARRIVAL", capturedAt })), capturedAt);
  return "QUEUED";
}

export async function saveSyntheticEvidence(kind: "INSPECTION" | "SIGNATURE", content: string): Promise<string> {
  const normalized = content.trim();
  if (normalized.length < 1) throw new Error("Enter a test value before saving.");
  const db = await database();
  const digest = await createEvidenceDigest(`${kind}:${normalized}`);
  const draftId = `evd_${digest.slice(0, 24)}`;
  await db.runAsync(`INSERT INTO evidence_draft (draft_id,kind,digest,encrypted_content,state,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(draft_id) DO UPDATE SET encrypted_content=excluded.encrypted_content,state='DRAFT'`,
    draftId, kind, digest, encode(normalized), "DRAFT", new Date().toISOString());
  return draftId;
}

export async function queueSyntheticEvidence(draftId: string): Promise<void> {
  if (!/^evd_[a-f0-9]{24}$/.test(draftId)) throw new Error("EVIDENCE_REFERENCE_INVALID");
  const db = await database(); const result = await db.runAsync("UPDATE evidence_draft SET state='QUEUED' WHERE draft_id=? AND state='DRAFT'", draftId);
  if (result.changes !== 1) throw new Error("EVIDENCE_DRAFT_NOT_QUEUEABLE");
}

export async function supersedeSyntheticEvidence(draftId: string): Promise<void> {
  if (!/^evd_[a-f0-9]{24}$/.test(draftId)) throw new Error("EVIDENCE_REFERENCE_INVALID");
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE evidence_draft SET state='SUPERSEDED' WHERE draft_id=? AND state IN ('DRAFT','QUEUED')", draftId);
    await db.runAsync("UPDATE evidence_blob SET state='SUPERSEDED' WHERE draft_id=? AND state='DRAFT'", draftId);
  });
}

export async function supersedeSyntheticDefectPhoto(digest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("EVIDENCE_DIGEST_INVALID");
  return supersedeSyntheticEvidence(`evd_${digest.slice(0, 24)}`);
}

export async function saveSyntheticDefectPhoto(base64: string): Promise<string> {
  if (base64.length < 100 || base64.length > 4_000_000 || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error("SYNTHETIC_PHOTO_INVALID");
  const db = await database(); const digest = await createEvidenceDigest(`DEFECT_PHOTO:${base64}`);
  const draftId = `evd_${digest.slice(0, 24)}`; const blobId = `blob_${digest.slice(0, 24)}`; const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`INSERT INTO evidence_draft (draft_id,kind,digest,encrypted_content,state,created_at) VALUES (?,'INSPECTION',?,?,'DRAFT',?)
      ON CONFLICT(draft_id) DO UPDATE SET encrypted_content=excluded.encrypted_content,state='DRAFT'`, draftId, digest, encode("SYNTHETIC_DEFECT_PHOTO"), now);
    await db.runAsync(`INSERT INTO evidence_blob (blob_id,draft_id,digest,encrypted_content,state) VALUES (?,?,?,?, 'DRAFT')
      ON CONFLICT(blob_id) DO UPDATE SET encrypted_content=excluded.encrypted_content,state='DRAFT'`, blobId, draftId, digest, encode(base64));
  });
  return digest;
}

async function persistLocations(samples: readonly DriverLocationSample[]): Promise<void> {
  const db = await database();
  await db.withTransactionAsync(async () => {
    for (const sample of samples) await db.runAsync(`INSERT OR IGNORE INTO location_sample
      (sample_id,epoch,sequence,captured_at,encrypted_sample,policy_version,state) VALUES (?,?,?,?,?,?,?)`,
      sample.sampleId, sample.epoch, sample.sequence, sample.capturedAt, encode(JSON.stringify(sample)), sample.policyVersion, "PENDING");
  });
}

const precise = (permission: Location.LocationPermissionResponse) =>
  Platform.OS === "android" ? permission.android?.accuracy === "fine" : permission.ios?.accuracy !== "reduced";

export async function trackingStatus(): Promise<{ readonly state: string; readonly detail: string; readonly active: boolean }> {
  const foreground = await Location.getForegroundPermissionsAsync();
  const background = await Location.getBackgroundPermissionsAsync();
  const active = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  if (!foreground.granted) return { state: "Location permission needed", detail: "Allow precise location to start a test shift.", active: false };
  if (!precise(foreground)) return { state: "Precise location is off", detail: "Turn on precise location in Android Settings before starting.", active: false };
  if (!background.granted) return { state: "Background access needed", detail: "Open Android Settings and choose Allow all the time, then come back here.", active: false };
  if (active) {
    const db = await database();
    const epoch = await db.getFirstAsync<{ readonly epoch: number; readonly tracking_generation: string }>(
      "SELECT epoch,tracking_generation FROM location_epoch WHERE state='ACTIVE' ORDER BY epoch DESC LIMIT 1");
    if (!epoch) return { state: "Location needs a restart", detail: "Stop location sharing, then start the test shift again.", active: true };
    const last = await db.getFirstAsync<{ readonly sequence: number }>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM location_sample WHERE epoch=?", epoch.epoch);
    configureBackgroundLocation({ generation: epoch.tracking_generation, epoch: epoch.epoch, initialSequence: last?.sequence ?? 0, persist: persistLocations });
  }
  return active
    ? { state: "Sharing location", detail: "Test location samples are being saved securely on this phone.", active: true }
    : { state: "Ready to start", detail: "Location access is ready. Start the shift when you are ready.", active: false };
}

export async function startSyntheticTracking(): Promise<{ readonly state: string; readonly detail: string; readonly active: boolean }> {
  let foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted) foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) return { state: "Location permission denied", detail: "The shift did not start. You can allow location in Android Settings.", active: false };
  if (!precise(foreground)) return { state: "Precise location is off", detail: "Turn on precise location in Android Settings before starting.", active: false };
  let background = await Location.getBackgroundPermissionsAsync();
  if (!background.granted) background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) return { state: "Background access needed", detail: "Choose Allow all the time in Android Settings, return here, and tap Start test shift again.", active: false };
  if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)) return trackingStatus();
  const db = await database();
  const row = await db.getFirstAsync<{ readonly epoch: number }>("SELECT COALESCE(MAX(epoch),0)+1 AS epoch FROM location_epoch");
  const epoch = row?.epoch ?? 1;
  const generation = `trk_synthetic${String(epoch).padStart(7, "0")}`;
  await db.runAsync("INSERT INTO location_epoch (epoch,tracking_generation,policy_version,state,started_at) VALUES (?,?,?,?,?)",
    epoch, generation, DEFAULT_SAMPLING_POLICY.version, "ACTIVE", new Date().toISOString());
  configureBackgroundLocation({ generation, epoch, initialSequence: 0, persist: persistLocations });
  try {
    await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: DEFAULT_SAMPLING_POLICY.foregroundSeconds * 1000,
      distanceInterval: 5,
      deferredUpdatesInterval: DEFAULT_SAMPLING_POLICY.movingBackgroundSeconds * 1000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "KavaRoutes synthetic test shift",
        notificationBody: "Location collection is active. Open KavaRoutes to stop it.",
        notificationColor: "#0b6e4f",
        killServiceOnDestroy: false,
      },
    });
  } catch (error) {
    await db.runAsync("UPDATE location_epoch SET state='ERROR' WHERE epoch=?", epoch);
    throw error;
  }
  return { state: "Sharing location", detail: "Test location samples are being saved securely on this phone.", active: true };
}

export async function stopSyntheticTracking(): Promise<{ readonly state: string; readonly detail: string; readonly active: boolean }> {
  if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK)) await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  const db = await database();
  await db.runAsync("UPDATE location_epoch SET state='STOPPED' WHERE state='ACTIVE'");
  return { state: "Location sharing stopped", detail: "KavaRoutes is no longer collecting location samples.", active: false };
}

export async function manualSyntheticSync(outcome: "ACCEPTED" | "CONFLICT" = "ACCEPTED"): Promise<{ readonly outcome: "ACCEPTED" | "CONFLICT"; readonly state: string; readonly detail: string }> {
  const db = await database();
  const counts = await db.getFirstAsync<{ readonly actions: number; readonly locations: number; readonly evidence: number }>(`SELECT
    (SELECT COUNT(*) FROM client_action WHERE state='PENDING') AS actions,
    (SELECT COUNT(*) FROM location_sample WHERE state='PENDING') AS locations,
    (SELECT COUNT(*) FROM evidence_draft WHERE state IN ('DRAFT','QUEUED')) AS evidence`);
  const pending = (counts?.actions ?? 0) + (counts?.locations ?? 0) + (counts?.evidence ?? 0);
  if (outcome === "CONFLICT") return { outcome, state: "Conflict needs review", detail: `${pending} local test item${pending === 1 ? " remains" : "s remain"} unchanged. The authoritative itinerary was preserved.` };
  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE client_action SET state='ACCEPTED' WHERE state='PENDING'");
    await db.runAsync("UPDATE location_sample SET state='ACCEPTED' WHERE state='PENDING'");
    await db.runAsync("UPDATE evidence_draft SET state='ACCEPTED' WHERE state IN ('DRAFT','QUEUED')");
    await db.runAsync("UPDATE evidence_blob SET state='ACCEPTED' WHERE state='DRAFT'");
  });
  return pending > 0
    ? { outcome, state: "Accepted by synthetic server", detail: `${pending} test item${pending === 1 ? " was" : "s were"} accepted by the in-process fake. No public or production server was contacted.` }
    : { outcome, state: "Nothing waiting", detail: "There are no local database items waiting. No public or production server was contacted." };
}

export async function readSafeDiagnostics(): Promise<{ readonly actions: number; readonly locations: number; readonly evidence: number; readonly tracking: boolean }> {
  const db = await database();
  const counts = await db.getFirstAsync<{ readonly actions: number; readonly locations: number; readonly evidence: number }>(`SELECT
    (SELECT COUNT(*) FROM client_action) AS actions,
    (SELECT COUNT(*) FROM location_sample) AS locations,
    (SELECT COUNT(*) FROM evidence_draft) AS evidence`);
  return { actions: counts?.actions ?? 0, locations: counts?.locations ?? 0, evidence: counts?.evidence ?? 0,
    tracking: await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK) };
}

const decodeSample = (value: Uint8Array | string) => JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as { readonly latitude: number; readonly longitude: number };
const radians = (value: number) => value * Math.PI / 180;
export async function evaluateReturnLocation(): Promise<"PASS" | "OUTSIDE" | "STALE" | "INACCURATE" | "UNAVAILABLE"> {
  try {
    const db = await database();
    const anchor = await db.getFirstAsync<{ readonly encrypted_sample: Uint8Array | string }>("SELECT encrypted_sample FROM location_sample ORDER BY captured_at ASC LIMIT 1");
    if (!anchor) return "UNAVAILABLE";
    const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }); const age = Date.now() - current.timestamp;
    if (age > DEFAULT_SAMPLING_POLICY.staleAfterSeconds * 1000) return "STALE";
    if ((current.coords.accuracy ?? 10_000) > 100) return "INACCURATE";
    const origin = decodeSample(anchor.encrypted_sample); const latitudeDelta = radians(current.coords.latitude - origin.latitude); const longitudeDelta = radians(current.coords.longitude - origin.longitude);
    const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(origin.latitude)) * Math.cos(radians(current.coords.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
    const meters = 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
    return meters <= 250 ? "PASS" : "OUTSIDE";
  } catch { return "UNAVAILABLE"; }
}

const SYNTHETIC_STOP_COORDINATES = Object.freeze([
  { kind: "COORDINATE", latitude: 34.053691, longitude: -118.242766 },
  { kind: "COORDINATE", latitude: 34.050233, longitude: -118.255999 },
  { kind: "COORDINATE", latitude: 34.056219, longitude: -118.236502 },
  { kind: "COORDINATE", latitude: 34.055345, longitude: -118.249845 },
] as const);

export async function openSyntheticNavigation(stopIndex = 0) {
  const destination = SYNTHETIC_STOP_COORDINATES[stopIndex];
  if (!destination) throw new Error("DIRECTIONS_STOP_UNAVAILABLE");
  const outcome = await handoffNavigation({ open: (url) => Linking.openURL(url) }, destination,
    Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other");
  if (outcome === "UNAVAILABLE") throw new Error(Platform.OS === "ios" ? "Apple Maps could not be opened." : "Google Maps could not be opened.");
  return outcome;
}

export async function watchSyntheticVehicleMotion(initial: VehicleMotionState, onChange: (state: VehicleMotionState) => void): Promise<{ remove(): void }> {
  let motion = initial;
  return Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 3_000, distanceInterval: 2 }, (location) => {
    const next = updateVehicleMotion(motion, { speedMetersPerSecond: location.coords.speed, accuracyMeters: location.coords.accuracy });
    if (next.moving !== motion.moving || next.stationaryConfirmations !== motion.stationaryConfirmations) { motion = next; onChange(next); }
  });
}

export function openApplicationSettings() { return Linking.openSettings(); }
