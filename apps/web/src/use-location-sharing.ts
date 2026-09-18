import { useCallback, useEffect, useRef, useState } from "react";
import type { DriverLocationBatchRequest } from "@kavaroutes/api-contracts";
import { initialLocationSharing, locationRetryInSeconds, locationSharingAllowsShift, locationSharingCanRetry, locationSharingPrompt, locationSharingReducer,
  locationSilentSeconds, SAMPLE_INTERVAL_MILLISECONDS, STALE_AFTER_SECONDS, type LocationSharingState, type LocationStopReason } from "./location-sharing";

/** The shift a feed belongs to. Absent before the shift exists, so fixes are buffered
 * rather than refused; the server accepts a fix captured just before the shift start. */
export interface LocationSharingTarget { readonly shiftReference: string; readonly shiftGeneration: string; readonly deviceId: string }
export interface LocationBatchSender {
  locationBatch(shiftReference: string, request: DriverLocationBatchRequest, key: string): Promise<unknown>;
}
export interface LocationSharingController {
  readonly state: LocationSharingState;
  readonly prompt: string | null;
  readonly silentSeconds: number;
  readonly retryInSeconds: number | null;
  readonly canRetry: boolean;
  /** Requests permission (the browser prompt) and starts the feed. Resolves true only
   * when a fix has been read, which is what lets a driver sign in. */
  requestSharing(): Promise<boolean>;
  /** Re-issues the feed without a fresh prompt; used by the 30 s retry. */
  retryNow(): void;
  stopSharing(reason: LocationStopReason): void;
}

const geolocationErrorCode = (error: unknown): "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT" => {
  const code = (error as { code?: number } | null)?.code;
  if (code === 1) return "PERMISSION_DENIED";
  if (code === 3) return "TIMEOUT";
  return "POSITION_UNAVAILABLE";
};

/** One watcher for the whole shift: it buffers fixes, reports them in batches, notices a
 * silence before the server's own alert threshold, retries every 30 s, and stops when the
 * shift ends. The transitions themselves live in `location-sharing.ts`. */
export function useLocationSharing(input: { target: LocationSharingTarget | null; api: LocationBatchSender }): LocationSharingController {
  const [state, setState] = useState<LocationSharingState>(initialLocationSharing);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state); stateRef.current = state;
  const targetRef = useRef(input.target); targetRef.current = input.target;
  const apiRef = useRef(input.api); apiRef.current = input.api;
  const watchRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const bufferRef = useRef<DriverLocationBatchRequest["samples"][number][]>([]);
  const sendingRef = useRef(false);

  const stopWatch = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
  }, []);

  const enqueue = useCallback((position: GeolocationPosition) => {
    sequenceRef.current += 1;
    bufferRef.current.push({
      sampleId: crypto.randomUUID(), sequence: sequenceRef.current, capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracyMeters: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
    });
    // Bound the buffer: a long outage keeps the newest fixes rather than growing forever.
    if (bufferRef.current.length > 240) bufferRef.current.splice(0, bufferRef.current.length - 240);
  }, []);

  const flush = useCallback(async () => {
    const target = targetRef.current;
    if (!target || sendingRef.current || !bufferRef.current.length) return;
    const samples = bufferRef.current.splice(0, 60);
    const batchReference = crypto.randomUUID();
    sendingRef.current = true;
    try { await apiRef.current.locationBatch(target.shiftReference, { shiftGeneration: target.shiftGeneration, batchReference, deviceId: target.deviceId, samples }, `driver-location-${batchReference}`); }
    catch { bufferRef.current.unshift(...samples); }
    finally { sendingRef.current = false; }
  }, []);

  const startWatch = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    stopWatch();
    watchRef.current = navigator.geolocation.watchPosition(
      position => { setState(current => locationSharingReducer(current, { type: "SAMPLE", now: Date.now(), capturedAt: position.timestamp || Date.now() })); enqueue(position); },
      error => {
        const code = geolocationErrorCode(error);
        setState(current => {
          if (code !== "PERMISSION_DENIED") return locationSharingReducer(current, { type: "WATCH_ERROR", now: Date.now(), code: "WATCH_ERROR" });
          // A refusal at the prompt fails the sign-in; a later revocation is treated as a
          // lost signal first, then as a refusal once a retry is refused again.
          return current.phase === "REQUESTING" || current.phase === "DENIED"
            ? locationSharingReducer(current, { type: "PERMISSION_DENIED", now: Date.now() })
            : locationSharingReducer(current, { type: "WATCH_ERROR", now: Date.now(), code: "PERMISSION_REVOKED" });
        });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
  }, [enqueue, stopWatch]);

  const requestSharing = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === "undefined") { setState(current => locationSharingReducer(current, { type: "SIGN_IN", now: Date.now(), supported: false, secureContext: false })); return false; }
    const secureContext = typeof window === "undefined" || window.isSecureContext || location.hostname === "127.0.0.1" || location.hostname === "localhost";
    if (!navigator.geolocation) {
      setState(current => locationSharingReducer(current, { type: "SIGN_IN", now: Date.now(), supported: false, secureContext }));
      return false;
    }
    if (!secureContext) {
      setState(current => locationSharingReducer(current, { type: "SIGN_IN", now: Date.now(), supported: true, secureContext: false }));
      return false;
    }
    setState(current => locationSharingReducer(current, { type: "SIGN_IN", now: Date.now(), supported: true, secureContext: true }));
    const first = await new Promise<{ position: GeolocationPosition | null; refused: boolean }>(resolve => {
      navigator.geolocation.getCurrentPosition(position => resolve({ position, refused: false }),
        error => resolve({ position: null, refused: geolocationErrorCode(error) === "PERMISSION_DENIED" }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 });
    });
    if (!first.position) {
      // A refusal is the case the shift rule is about; a timeout or an unavailable fix is
      // retryable and reads as a lost signal rather than as a refusal.
      setState(current => first.refused
        ? locationSharingReducer(current, { type: "PERMISSION_DENIED", now: Date.now() })
        : locationSharingReducer(current, { type: "WATCH_ERROR", now: Date.now(), code: "WATCH_ERROR" }));
      return false;
    }
    const firstPosition = first.position;
    setState(current => locationSharingReducer(locationSharingReducer(current, { type: "PERMISSION_GRANTED", now: Date.now() }), { type: "SAMPLE", now: Date.now(), capturedAt: firstPosition.timestamp || Date.now() }));
    enqueue(firstPosition);
    startWatch();
    return true;
  }, [enqueue, startWatch]);

  const retryNow = useCallback(() => { startWatch(); void flush(); }, [flush, startWatch]);
  const stopSharing = useCallback((reason: LocationStopReason) => { stopWatch(); void flush(); setState(current => locationSharingReducer(current, { type: "SIGN_OUT", now: Date.now(), reason })); }, [flush, stopWatch]);

  // Silence is noticed locally first; the server's own alert threshold stays later.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stamp = Date.now(); setNow(stamp);
      setState(current => locationSharingReducer(locationSharingReducer(current, { type: "STALE", now: stamp }), { type: "RETRY_DUE", now: stamp }));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);
  // A lost feed re-issues the watcher when its next retry is due: 30 s after the loss,
  // then every 30 s, including after the escalation that asks dispatch to call.
  useEffect(() => {
    if (state.phase !== "SIGNAL_LOST" && state.phase !== "ESCALATED") return;
    const timer = window.setTimeout(() => { startWatch(); void flush(); }, Math.max(0, state.nextRetryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state, flush, startWatch]);
  useEffect(() => {
    const timer = window.setInterval(() => void flush(), SAMPLE_INTERVAL_MILLISECONDS);
    return () => window.clearInterval(timer);
  }, [flush]);
  useEffect(() => () => stopWatch(), [stopWatch]);

  return { state, prompt: locationSharingPrompt(state), silentSeconds: locationSilentSeconds(state, now), retryInSeconds: locationRetryInSeconds(state, now),
    canRetry: locationSharingCanRetry(state), requestSharing, retryNow, stopSharing };
}
export { locationSharingAllowsShift, STALE_AFTER_SECONDS };
