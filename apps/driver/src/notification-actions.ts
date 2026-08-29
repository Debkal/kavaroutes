import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { parseNativeNotification, permissionState, type PushPermissionState } from "@kavaroutes/driver-core";

const CHANNEL_ID = "dispatch_updates";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function initializeNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "KavaRoutes updates", importance: Notifications.AndroidImportance.DEFAULT,
    sound: null, vibrationPattern: null, enableVibrate: false, showBadge: false,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

export async function readNotificationPermission(): Promise<PushPermissionState> {
  const current = await Notifications.getPermissionsAsync();
  const provisional = Platform.OS === "ios" && current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  const channel = Platform.OS === "android" ? await Notifications.getNotificationChannelAsync(CHANNEL_ID) : null;
  return permissionState({ requested: current.status !== "undetermined", granted: current.granted, provisional,
    systemEnabled: current.status !== "denied", ...(Platform.OS === "android" ? { channelEnabled: Boolean(channel) && channel?.importance !== Notifications.AndroidImportance.NONE } : {}) });
}

export async function requestNotificationPermissionInContext(): Promise<PushPermissionState> {
  await initializeNotificationChannel();
  const current = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false, allowProvisional: true } });
  const provisional = Platform.OS === "ios" && current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  return permissionState({ requested: true, granted: current.granted, provisional, systemEnabled: current.status !== "denied", channelEnabled: true });
}

export async function getDirectProviderToken(providerConfigured: boolean): Promise<{ readonly platform: "ios" | "android"; readonly token: string }> {
  if (!providerConfigured) throw new Error("PUSH_PROVIDER_NOT_CONFIGURED_HIG_013_REQUIRED");
  const result = await Notifications.getDevicePushTokenAsync();
  const token = typeof result.data === "string" ? result.data : String(result.data);
  if (token.length < 16) throw new Error("NATIVE_PUSH_TOKEN_INVALID");
  return Object.freeze({ platform: Platform.OS === "ios" ? "ios" : "android", token });
}

export function subscribeToNotificationRecovery(onWake: (reason: "notification" | "foreground", data?: unknown) => Promise<void>): { remove(): void } {
  const received = Notifications.addNotificationReceivedListener((notification) => {
    const data = notification.request.content.data;
    if (parseNativeNotification(data)) void onWake("notification", data);
  });
  const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (parseNativeNotification(data)) void onWake("notification", data);
  });
  const appState = AppState.addEventListener("change", (state) => { if (state === "active") void onWake("foreground"); });
  return Object.freeze({ remove() { received.remove(); tapped.remove(); appState.remove(); } });
}
