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
    const next = await requestNotificationPermissionInContext(); setPermission(next);
    setDetail(next === "denied" ? "Notifications are off. The Driver app still works and checks for updates when opened." : "Generic KavaRoutes update notices are allowed. They never contain trip or rider details.");
  };
  const refresh = async () => { const result = await recoverUpdates("foreground"); setDetail(result.detail); };
  return <FeasibilityScreen title="Updates" summary="Notification hints are optional and never change a trip. This local build uses no external push provider.">
    <StatusCard title="Notification setting" status={permission.replaceAll("_", " ")}><Text>{detail}</Text></StatusCard>
    {permission === "not_requested" ? <PrimaryButton label="Allow generic update notices" onPress={enable} /> : null}
    <PrimaryButton label="Check for updates now" onPress={refresh} />
  </FeasibilityScreen>;
}
