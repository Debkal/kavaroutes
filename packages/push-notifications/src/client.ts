import { validatePushEnvelope, type PushEnvelope } from "./contracts.js";

export const PUSH_PERMISSION_STATES = ["not_requested", "provisional", "granted", "denied", "channel_limited", "system_disabled"] as const;
export type PushPermissionState = typeof PUSH_PERMISSION_STATES[number];

export interface NotificationRecoveryPort {
  authenticate(): Promise<"authenticated" | "reauthenticated">;
  synchronize(reason: "notification" | "foreground" | "start" | "reconnect"): Promise<{ readonly projectionDigest: string }>;
  openSafeUpdatesEntry(): Promise<void>;
}

export function parseNativeNotification(data: unknown): PushEnvelope | null {
  try { return validatePushEnvelope(data); } catch { return null; }
}

export function createNotificationRecovery(port: NotificationRecoveryPort) {
  let lastDigest: string | undefined;
  const recover = async (reason: "notification" | "foreground" | "start" | "reconnect", data?: unknown) => {
    if (reason === "notification" && !parseNativeNotification(data)) return Object.freeze({ outcome: "ignored" as const, projectionDigest: lastDigest });
    if (reason === "notification") await port.openSafeUpdatesEntry();
    await port.authenticate();
    const result = await port.synchronize(reason);
    lastDigest = result.projectionDigest;
    return Object.freeze({ outcome: "synchronized" as const, projectionDigest: result.projectionDigest });
  };
  return Object.freeze({ recover, lastProjectionDigest: () => lastDigest });
}

export function permissionState(input: { readonly requested: boolean; readonly granted: boolean; readonly provisional?: boolean; readonly systemEnabled: boolean; readonly channelEnabled?: boolean }): PushPermissionState {
  if (!input.systemEnabled) return "system_disabled";
  if (!input.requested) return "not_requested";
  if (!input.granted) return "denied";
  if (input.channelEnabled === false) return "channel_limited";
  if (input.provisional) return "provisional";
  return "granted";
}
