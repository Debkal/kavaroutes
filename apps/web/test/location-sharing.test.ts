import { describe, expect, it } from "vitest";
import { initialLocationSharing, locationRetryInSeconds, locationSharingAllowsShift, locationSharingPrompt, locationSharingReducer, locationSilentSeconds,
  MAX_RETRIES, RETRY_AFTER_SECONDS, STALE_AFTER_SECONDS, type LocationSharingState } from "../src/location-sharing";

const signIn = (now = 0) => locationSharingReducer(initialLocationSharing, { type: "SIGN_IN", now, supported: true, secureContext: true });
const sharing = (now = 0): LocationSharingState => locationSharingReducer(signIn(now), { type: "PERMISSION_GRANTED", now });
const apply = (state: LocationSharingState, ...events: Parameters<typeof locationSharingReducer>[1][]) => events.reduce(locationSharingReducer, state);

describe("live location sharing state machine", () => {
  it("asks for permission on sign-in and fails the sign-in when it is refused", () => {
    expect(signIn().phase).toBe("REQUESTING");
    const denied = locationSharingReducer(signIn(), { type: "PERMISSION_DENIED", now: 1000 });
    expect(denied.phase).toBe("DENIED");
    expect(locationSharingAllowsShift(denied)).toBe(false);
    expect(locationSharingPrompt(denied)).toMatch(/sign-in failed/);
    expect(locationSharingAllowsShift(initialLocationSharing)).toBe(false);
  });

  it("fails the sign-in where the browser cannot share a location", () => {
    const unsupported = locationSharingReducer(initialLocationSharing, { type: "SIGN_IN", now: 0, supported: false, secureContext: true });
    expect(unsupported).toMatchObject({ phase: "UNSUPPORTED", code: "NO_GEOLOCATION_API" });
    const insecure = locationSharingReducer(initialLocationSharing, { type: "SIGN_IN", now: 0, supported: true, secureContext: false });
    expect(insecure).toMatchObject({ phase: "UNSUPPORTED", code: "INSECURE_CONTEXT" });
    expect(locationSharingAllowsShift(unsupported)).toBe(false);
  });

  it("shares, counts fixes and allows the shift once permission is granted", () => {
    const state = apply(sharing(1000), { type: "SAMPLE", now: 4000, capturedAt: 3900 }, { type: "SAMPLE", now: 14_000, capturedAt: 13_900 });
    expect(state).toMatchObject({ phase: "SHARING", samples: 2, reconnects: 0 });
    expect(locationSharingAllowsShift(state)).toBe(true);
    expect(locationSilentSeconds(state, 14_000)).toBe(0);
    expect(locationSilentSeconds(state, 15_500)).toBe(2);
  });

  it("moves to a lost signal on a watch error and retries every 30 seconds", () => {
    const lost = locationSharingReducer(sharing(0), { type: "WATCH_ERROR", now: 10_000, code: "WATCH_ERROR" });
    expect(lost).toMatchObject({ phase: "SIGNAL_LOST", attempt: 0, nextRetryAt: 10_000 + RETRY_AFTER_SECONDS * 1000 });
    expect(locationRetryInSeconds(lost, 15_000)).toBe(25);
    expect(locationRetryInSeconds(lost, 40_000)).toBe(0);
    expect(locationSharingAllowsShift(lost)).toBe(true);
    expect(locationSharingPrompt(lost)).toMatch(/Retrying every 30 seconds/);
  });

  it("escalates to dispatch after the retries are exhausted, naming the silence", () => {
    let state: LocationSharingState = locationSharingReducer(sharing(0), { type: "STALE", now: STALE_AFTER_SECONDS * 1000 + 10 });
    expect(state.phase).toBe("SIGNAL_LOST");
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      const nextRetryAt = (state as Extract<LocationSharingState, { phase: "SIGNAL_LOST" }>).nextRetryAt;
      state = locationSharingReducer(state, { type: "RETRY_DUE", now: nextRetryAt });
    }
    expect(state.phase).toBe("ESCALATED");
    expect(locationSharingPrompt(state)).toMatch(/dispatch has been asked to contact you/);
    expect(locationSharingAllowsShift(state)).toBe(true);
    expect(locationSilentSeconds(state, 200_000)).toBe(200);
    const later = locationSharingReducer(state, { type: "RETRY_DUE", now: 200_000 });
    expect(later.phase).toBe("ESCALATED");
  });

  it("returns to sharing on the next fix and counts the reconnection", () => {
    const lost = locationSharingReducer(sharing(0), { type: "WATCH_ERROR", now: 10_000, code: "NO_SAMPLES" });
    const recovered = locationSharingReducer(lost, { type: "SAMPLE", now: 45_000, capturedAt: 44_900 });
    expect(recovered).toMatchObject({ phase: "SHARING", reconnects: 1, samples: 0 });
    const lostAgain = locationSharingReducer(recovered, { type: "STALE", now: 45_000 + STALE_AFTER_SECONDS * 1000 + 5 });
    expect(lostAgain).toMatchObject({ phase: "SIGNAL_LOST", reconnects: 1 });
  });

  it("treats a revoked permission as a refusal, and a sign-out as the end", () => {
    const revoked = locationSharingReducer(sharing(0), { type: "WATCH_ERROR", now: 5_000, code: "PERMISSION_REVOKED" });
    expect(revoked).toMatchObject({ phase: "SIGNAL_LOST", reason: "PERMISSION_REVOKED" });
    expect(locationSharingReducer(initialLocationSharing, { type: "SIGN_OUT", now: 9, reason: "SHIFT_ENDED" })).toMatchObject({ phase: "STOPPED", reason: "SHIFT_ENDED" });
    expect(locationSharingPrompt(locationSharingReducer(sharing(0), { type: "SIGN_OUT", now: 9, reason: "SHIFT_ENDED" }))).toMatch(/stopped with the shift/);
  });
});
