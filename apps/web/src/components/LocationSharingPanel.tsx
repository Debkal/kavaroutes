import type { LocationSharingController } from "../use-location-sharing";

/**
 * The driver's disconnect panel. It is always visible at the bottom of the driving
 * surface, because a lost feed is something the driver has to fix — and after the retries
 * are exhausted it is the point at which dispatch is asked to call.
 */
export function LocationSharingPanel({ controller, busy = false }:{ controller: LocationSharingController; busy?: boolean }) {
  const { state, prompt, silentSeconds, retryInSeconds, canRetry } = controller;
  const lost = state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED";
  const denied = state.phase === "DENIED" || state.phase === "UNSUPPORTED";
  const detail = lost
    ? `No location update received for ${silentSeconds} s.${retryInSeconds === null ? "" : ` Retrying in ${retryInSeconds} s.`}`
    : denied ? "The shift cannot start until location sharing is allowed." : silentSeconds > 0 ? `Last update ${silentSeconds} s ago.` : "Sending your position to dispatch while the shift is open.";
  return <section className={`driver-location-bar ${lost ? "lost" : denied ? "denied" : state.phase === "SHARING" ? "sharing" : "idle"}`}
    aria-label="Location sharing" role={lost || denied ? "alert" : "status"}>
    <div><strong>{state.phase === "ESCALATED" ? "Dispatch has been asked to contact you" : lost ? "Location lost" : denied ? "Location sharing is required" : state.phase === "SHARING" ? "Sharing your location" : "Location sharing"}</strong>
      <span>{prompt}</span><span>{detail}</span>
      {state.phase === "ESCALATED" ? <span>Keep the app open; the feed keeps retrying every 30 seconds.</span> : null}</div>
    {canRetry ? <button type="button" disabled={busy} onClick={() => { void controller.requestSharing(); }}>Enable location sharing</button> : null}
  </section>;
}
