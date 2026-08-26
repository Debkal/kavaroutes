const allowed = new Set(["metric", "outcome", "state", "durationBucket", "platform", "permission"]);
export function safeDriverTelemetry(value: Readonly<Record<string, string | undefined>>) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`DRIVER_TELEMETRY_FIELD_PROHIBITED:${key}`);
  for (const item of Object.values(value)) if (item && item.length > 64) throw new Error("DRIVER_TELEMETRY_VALUE_TOO_LONG");
  return Object.freeze({ ...value });
}
