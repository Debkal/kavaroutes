import { useEffect, useState } from "react";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { readNotificationPermission, requestNotificationPermissionInContext } from "../src/notification-actions";
import { useWorkflow } from "../src/workflow-context";

export default function UpdatesScreen() {
  const { recoverUpdates } = useWorkflow();
  const [permission, setPermission] = useState("Checking settings");
  const [detail, setDetail] = useState("Push is optional. KavaRoutes always checks authoritative state when the app opens or reconnects.");
  useEffect(() => { void readNotificationPermission().then(setPermission).catch(() => setPermission("system_disabled")); }, []);
  const enable = async () => {
    try {
      const next = await requestNotificationPermissionInContext(); setPermission(next);
      setDetail(next === "denied" ? "Notifications are off. Manual recovery remains available." : "Notification preference saved. This prototype has no active external push provider; use manual recovery to check the backend.");
    } catch { setDetail("Notification settings could not be changed. Manual recovery remains available."); }
  };
  const refresh = async () => {
    try { const result = await recoverUpdates("foreground"); setDetail(result.detail); }
    catch { setDetail("Recovery unavailable. Original queued requests are preserved; reconnect and retry without creating replacements."); }
  };
  return <FeasibilityScreen title="Updates" summary="Notification hints are optional and never change a trip. This local build uses no external push provider.">
    <StatusCard title="Notification setting" status={permission.replaceAll("_", " ")}><Text>{detail}</Text></StatusCard>
    {permission === "not_requested" ? <PrimaryButton label="Allow generic update notices" onPress={enable} /> : null}
    <PrimaryButton label="Check for updates now" onPress={refresh} />
  </FeasibilityScreen>;
}
