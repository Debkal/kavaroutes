/**
 * The live location-sharing state machine.
 *
 * Location is a condition of the shift, not a setting: the driver signs in, the browser
 * asks for permission, and a refusal fails the sign-in. While the shift is open the app
 * watches the device and reports fixes; when the watch errors or the fixes stop arriving
 * the state moves to a lost signal, retries every `RETRY_AFTER_SECONDS`, and after
 * `MAX_RETRIES` failed attempts escalates so dispatch is told to contact the driver. The
 * elapsed silence is measured from the last fix the server acknowledged, so the number an
 * operator reads is time without updates, not a count of local errors.
 */

export const RETRY_AFTER_SECONDS = 30;
export const MAX_RETRIES = 3;
/** The client notices a lost feed before the server's 60 s alert threshold, so the driver
 * is told to fix it while the operator still sees the shift as current. */
export const STALE_AFTER_SECONDS = 30;
export const SAMPLE_INTERVAL_MILLISECONDS = 10_000;

export type LocationLossReason = "WATCH_ERROR" | "NO_SAMPLES" | "PERMISSION_REVOKED";
export type LocationStopReason = "SHIFT_ENDED" | "SIGNED_OUT" | "EMERGENCY_STOP";

export type LocationSharingState =
  | { readonly phase: "IDLE" }
  | { readonly phase: "REQUESTING"; readonly since: number }
  | { readonly phase: "UNSUPPORTED"; readonly code: "NO_GEOLOCATION_API" | "INSECURE_CONTEXT" }
  | { readonly phase: "DENIED"; readonly at: number; readonly code: LocationLossReason }
  | { readonly phase: "SHARING"; readonly since: number; readonly lastSampleAt: number; readonly samples: number; readonly reconnects: number }
  | { readonly phase: "SIGNAL_LOST"; readonly since: number; readonly lastSampleAt: number; readonly attempt: number; readonly nextRetryAt: number; readonly reason: LocationLossReason; readonly reconnects: number }
  | { readonly phase: "ESCALATED"; readonly since: number; readonly lastSampleAt: number; readonly attempt: number; readonly nextRetryAt: number; readonly reason: LocationLossReason; readonly reconnects: number }
  | { readonly phase: "STOPPED"; readonly at: number; readonly reason: LocationStopReason };

export type LocationSharingEvent =
  | { readonly type: "SIGN_IN"; readonly now: number; readonly supported: boolean; readonly secureContext: boolean }
  | { readonly type: "PERMISSION_GRANTED"; readonly now: number }
  | { readonly type: "PERMISSION_DENIED"; readonly now: number }
  | { readonly type: "SAMPLE"; readonly now: number; readonly capturedAt: number }
  | { readonly type: "WATCH_ERROR"; readonly now: number; readonly code: LocationLossReason }
  | { readonly type: "STALE"; readonly now: number }
  | { readonly type: "RETRY_DUE"; readonly now: number }
  | { readonly type: "RETRY_SUCCEEDED"; readonly now: number }
  | { readonly type: "SIGN_OUT"; readonly now: number; readonly reason: LocationStopReason };

export const initialLocationSharing: LocationSharingState = { phase: "IDLE" };

const lost = (state: { lastSampleAt: number; reconnects: number }, now: number, reason: LocationLossReason, attempt: number): LocationSharingState => ({
  phase: "SIGNAL_LOST", since: now, lastSampleAt: state.lastSampleAt, attempt, nextRetryAt: now + RETRY_AFTER_SECONDS * 1000, reason, reconnects: state.reconnects });

export function locationSharingReducer(state: LocationSharingState, event: LocationSharingEvent): LocationSharingState {
  switch (event.type) {
    case "SIGN_IN":
      if (!event.supported) return { phase: "UNSUPPORTED", code: "NO_GEOLOCATION_API" };
      if (!event.secureContext) return { phase: "UNSUPPORTED", code: "INSECURE_CONTEXT" };
      return { phase: "REQUESTING", since: event.now };
    case "PERMISSION_GRANTED":
      if (state.phase !== "REQUESTING" && state.phase !== "DENIED") return state;
      return { phase: "SHARING", since: event.now, lastSampleAt: event.now, samples: 0, reconnects: 0 };
    case "PERMISSION_DENIED":
      // A refusal fails the sign-in by design: without a map feed dispatch cannot see
      // the driver, so the shift must not start.
      return { phase: "DENIED", at: event.now, code: "PERMISSION_REVOKED" };
    case "SAMPLE":
      if (state.phase === "SHARING") return { ...state, lastSampleAt: event.now, samples: state.samples + 1 };
      if (state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED")
        return { phase: "SHARING", since: event.now, lastSampleAt: event.now, samples: 0, reconnects: state.reconnects + 1 };
      return state;
    case "WATCH_ERROR":
      if (state.phase === "SHARING") return lost(state, event.now, event.code, 0);
      if (state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED") return { ...state, reason: event.code };
      return state;
    case "STALE":
      if (state.phase !== "SHARING") return state;
      if (event.now - state.lastSampleAt < STALE_AFTER_SECONDS * 1000) return state;
      return lost(state, event.now, "NO_SAMPLES", 0);
    case "RETRY_DUE": {
      if (state.phase !== "SIGNAL_LOST" && state.phase !== "ESCALATED") return state;
      if (event.now < state.nextRetryAt) return state;
      const attempt = state.attempt + 1;
      if (state.phase === "SIGNAL_LOST" && attempt >= MAX_RETRIES) {
        // Retries are exhausted: dispatch is told to contact the driver, and the app keeps
        // trying anyway so the feed resumes without a reload.
        return { phase: "ESCALATED", since: state.since, lastSampleAt: state.lastSampleAt, attempt, nextRetryAt: event.now + RETRY_AFTER_SECONDS * 1000, reason: state.reason, reconnects: state.reconnects };
      }
      return { ...state, attempt, nextRetryAt: event.now + RETRY_AFTER_SECONDS * 1000 };
    }
    case "RETRY_SUCCEEDED":
      if (state.phase !== "SIGNAL_LOST" && state.phase !== "ESCALATED") return state;
      return { phase: "SHARING", since: event.now, lastSampleAt: event.now, samples: 0, reconnects: 1 };
    case "SIGN_OUT":
      return { phase: "STOPPED", at: event.now, reason: event.reason };
    default:
      return state;
  }
}

/** A shift may start only when location sharing is live or actively being restored. A
 * denied or unsupported state is what "the login fails" means here. */
export function locationSharingAllowsShift(state: LocationSharingState): boolean {
  return state.phase === "SHARING" || state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED";
}
/** The driver may be offered a retry only where a retry can change the outcome. */
export function locationSharingCanRetry(state: LocationSharingState): boolean {
  return state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED" || state.phase === "DENIED" || state.phase === "UNSUPPORTED";
}
export function locationSharingPrompt(state: LocationSharingState): string | null {
  switch (state.phase) {
    case "IDLE": return "Share your location to sign in. Dispatch needs to see your position for the whole shift.";
    case "REQUESTING": return "Waiting for your answer to the location prompt…";
    case "UNSUPPORTED": return state.code === "INSECURE_CONTEXT"
      ? "Location sharing needs an HTTPS address. Open the app on its https:// address and sign in again."
      : "This browser cannot share a location, so the shift cannot start here.";
    case "DENIED": return "Location sharing was refused, so the sign-in failed. Allow location for this site and sign in again.";
    case "SHARING": return "Sharing your location. Dispatch can see this shift.";
    case "SIGNAL_LOST": return "Location lost. Retrying every 30 seconds — keep the app open and allow location.";
    case "ESCALATED": return "Location is still lost and dispatch has been asked to contact you. Enable location sharing to resume.";
    case "STOPPED": return "Location sharing stopped with the shift.";
    default: return null;
  }
}
/** Seconds without a server-acknowledged fix; the number an operator or driver reads. */
export function locationSilentSeconds(state: LocationSharingState, now: number): number {
  if (state.phase === "SHARING") return Math.max(0, Math.round((now - state.lastSampleAt) / 1000));
  if (state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED") return Math.max(0, Math.round((now - state.lastSampleAt) / 1000));
  return 0;
}
export function locationRetryInSeconds(state: LocationSharingState, now: number): number | null {
  if (state.phase !== "SIGNAL_LOST" && state.phase !== "ESCALATED") return null;
  return Math.max(0, Math.ceil((state.nextRetryAt - now) / 1000));
}
