// Expo substitutes these two public build settings. No credentials or arbitrary
// environment lookup belong in the Driver. Transport still enforces loopback.
const mode = process.env.EXPO_PUBLIC_KAVAROUTES_BACKEND ?? 'local-synthetic';
if (!['local-synthetic','private-cloud'].includes(mode)) throw new Error('INVALID_BACKEND_MODE');
export const driverRuntime = Object.freeze({
  privateCloud: mode === 'private-cloud',
  apiUrl: process.env.EXPO_PUBLIC_KAVAROUTES_API_URL,
});
