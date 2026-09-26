/** Only the dedicated Driver WebView injects this object. Browser Driver stays unchanged. */
type NativeWebView = { postMessage(message: string): void };
declare global { interface Window { ReactNativeWebView?: NativeWebView } }

export type NativeTrackingState = 'idle' | 'starting' | 'active' | 'delayed' | 'stopped';
export interface NativeTrackingStatus { state: NativeTrackingState; message: string }
type Command = { type: 'PREPARE' } | { type: 'START'; token: string; driverId: string; shiftReference: string; shiftGeneration: string } | { type: 'STOP' } | { type: 'STATUS' };

export const nativeDriverAvailable = () => Boolean(window.ReactNativeWebView && window.location.origin === 'https://app.kavaroutes.com' && window.location.pathname === '/driver');

export function nativeDriverCommand(command: Command): Promise<NativeTrackingStatus> {
  if (!nativeDriverAvailable()) return Promise.reject(new Error('NATIVE_DRIVER_UNAVAILABLE'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error('NATIVE_DRIVER_TIMEOUT')); }, 20_000);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail as {requestId?: string; state?: NativeTrackingState; message?: string; error?: string} | undefined;
      if (detail?.requestId !== requestId) return;
      cleanup();
      if (detail.error) reject(new Error(detail.error));
      else resolve({state: detail.state ?? 'idle', message: detail.message ?? ''});
    };
    const cleanup = () => { window.clearTimeout(timeout); window.removeEventListener('kavaroutes-native-reply', listener); };
    window.addEventListener('kavaroutes-native-reply', listener);
    window.ReactNativeWebView!.postMessage(JSON.stringify({requestId, ...command}));
  });
}
