import type { DriverRoute } from "@kavaroutes/driver-core";
export const DRIVER_ROUTES: Readonly<Record<DriverRoute, string>> = Object.freeze({ SHIFT_HOME: "/", MANIFEST: "/manifest",
  STOP_DETAIL: "/stop/ref_synthetic_stop_0001", INSPECTION: "/inspection", SIGNATURE: "/signature", PROPOSAL: "/proposal",
  RETURN: "/return", SYNC: "/sync", DIAGNOSTICS: "/diagnostics" });
