import type { LocationSharingController } from "../use-location-sharing";
import type {useDriverScreenAwake} from '../use-driver-screen-awake';

/**
 * The driver's disconnect panel. It is always visible at the bottom of the driving
 * surface, because a lost feed is something the driver has to fix — and after the retries
 * are exhausted it is the point at which dispatch is asked to call.
 */
export function LocationSharingPanel({ controller, busy = false, screenAwake }:{ controller: LocationSharingController; busy?: boolean; screenAwake?: ReturnType<typeof useDriverScreenAwake>|undefined }) {
  const { state, prompt, silentSeconds, retryInSeconds, canRetry, deliveryError } = controller;
  const lost = state.phase === "SIGNAL_LOST" || state.phase === "ESCALATED";
  const denied = state.phase === "DENIED" || state.phase === "UNSUPPORTED";
  const detail = lost
    ? `No location update received for ${silentSeconds} s.${retryInSeconds === null ? "" : ` Retrying in ${retryInSeconds} s.`}`
    : denied ? "The shift cannot start until location sharing is allowed." : silentSeconds > 0 ? `Last device fix ${silentSeconds} s ago.` : "Sending your position to dispatch while the shift is open.";
  return <section className={`driver-location-bar ${lost || deliveryError ? "lost" : denied ? "denied" : state.phase === "SHARING" ? "sharing" : "idle"}`}
    aria-label="Location sharing" role={lost || denied || deliveryError ? "alert" : "status"}>
    <div><strong>{state.phase === "ESCALATED" ? "Dispatch has been asked to contact you" : lost ? "Location lost" : denied ? "Location sharing is required" : deliveryError ? "Location updates delayed" : state.phase === "SHARING" ? "Sharing your location" : "Location sharing"}</strong>
      <span>{deliveryError ? "Location is on, but delivery is delayed." : prompt}</span><span>{detail}</span>
      {deliveryError ? <span>Location updates have not reached the server. Keep this page open; the same batch will retry. Contact Dispatch if this continues.</span> : null}
      {state.phase === "ESCALATED" ? <span>Keep the app open; the feed keeps retrying every 30 seconds.</span> : null}</div>
    {screenAwake?<div className="driver-awake-control"><strong>On-screen tracking</strong><span>{screenAwake.state==='active'?'Screen awake while KavaRoutes stays visible.':screenAwake.state==='released'?'Screen wake lock paused. Keep this page visible to resume it.':screenAwake.state==='unavailable'?'This browser did not grant a screen wake lock.':'Keep the screen on during this shift to reduce tracking gaps.'}</span><span>Switching apps or locking the phone can pause browser GPS.</span>{screenAwake.enabled?<button type="button" onClick={screenAwake.turnOff}>Allow screen to sleep</button>:<button type="button" disabled={!screenAwake.supported} onClick={()=>void screenAwake.turnOn()}>Keep screen awake</button>}</div>:null}
    {canRetry ? <button type="button" disabled={busy} onClick={() => { void controller.requestSharing(); }}>Enable location sharing</button> : null}
  </section>;
}
