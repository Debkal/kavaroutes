/** Only the dedicated Driver WebView injects this object. Browser Driver stays unchanged. */
type NativeWebView = { postMessage(message: string): void };
declare global { interface Window { ReactNativeWebView?: NativeWebView } }

export type NativeTrackingState = 'idle' | 'starting' | 'active' | 'delayed' | 'stopped';
export interface NativeTrackingStatus { state: NativeTrackingState; message: string;token?:string;organizationId?:string;driverId?:string;loginId?:string }
type Command = { type: 'PREPARE' } | { type: 'START'; token: string; organizationId:string; driverId: string; shiftReference: string; shiftGeneration: string;loginId:string } | { type: 'STOP' } | { type: 'STATUS' } | {type:'RESUME'};

export const nativeDriverAvailable = () => Boolean(window.ReactNativeWebView && window.location.origin === 'https://driver.kavaroutes.com' && window.location.pathname === '/driver');

export function nativeDriverCommand(command: Command): Promise<NativeTrackingStatus> {
  if (!nativeDriverAvailable()) return Promise.reject(new Error('NATIVE_DRIVER_UNAVAILABLE'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // Android may open Settings for "Allow all the time". The WebView stays
    // alive, but the driver needs time to grant permission and return to it.
    const timeoutMs = command.type === 'PREPARE' ? 5 * 60_000 : command.type === 'START' || command.type === 'RESUME' ? 60_000 : 20_000;
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('NATIVE_DRIVER_TIMEOUT')); }, timeoutMs);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail as {requestId?: string; state?: NativeTrackingState; message?: string; error?: string;token?:string;organizationId?:string;driverId?:string;loginId?:string} | undefined;
      if (detail?.requestId !== requestId) return;
      cleanup();
      if (detail.error) reject(new Error(detail.error));
      else resolve({state: detail.state ?? 'idle', message: detail.message ?? '',...(detail.token?{token:detail.token}:{}),...(detail.organizationId?{organizationId:detail.organizationId}:{}),...(detail.driverId?{driverId:detail.driverId}:{}),...(detail.loginId?{loginId:detail.loginId}:{})});
    };
    const cleanup = () => { window.clearTimeout(timeout); window.removeEventListener('kavaroutes-native-reply', listener); };
    window.addEventListener('kavaroutes-native-reply', listener);
    window.ReactNativeWebView!.postMessage(JSON.stringify({requestId, ...command}));
  });
}
