import type { DriverRoute } from "@kavaroutes/driver-core";
export const DRIVER_ROUTES: Readonly<Record<DriverRoute, string>> = Object.freeze({ BOOTSTRAP: "/", TRACKING: "/tracking", MANIFEST: "/manifest",
  STOP_DETAIL: "/stop/ref_synthetic_stop_0001", ACTION: "/action", INSPECTION: "/inspection", SIGNATURE: "/signature", SYNC: "/sync",
  NAVIGATION: "/navigation", DIAGNOSTICS: "/diagnostics" });
