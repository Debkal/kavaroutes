import "../src/background-location";
import { Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { subscribeToNotificationRecovery } from "../src/notification-actions";
import { WorkflowProvider, useWorkflow } from "../src/workflow-context";

function NotificationRecoveryBridge() {
  const router = useRouter(); const { recoverUpdates } = useWorkflow();
  useEffect(() => {
    const subscription = subscribeToNotificationRecovery(async (reason, data) => {
      if (reason === "notification") router.push("/updates");
      await recoverUpdates(reason, data);
    });
    return () => subscription.remove();
  }, [recoverUpdates, router]);
  return null;
}

export default function RootLayout() { return <WorkflowProvider><NotificationRecoveryBridge /><Stack screenOptions={{ headerBackTitle: "Back", animation: "none" }}>
  <Stack.Screen name="index" options={{ title: "My shift" }} />
  <Stack.Screen name="manifest" options={{ title: "Today's stops" }} />
  <Stack.Screen name="stop/[reference]" options={{ title: "Stop details" }} />
  <Stack.Screen name="inspection" options={{ title: "Vehicle check" }} />
  <Stack.Screen name="signature" options={{ title: "Signature" }} />
  <Stack.Screen name="proposal" options={{ title: "Route change" }} />
  <Stack.Screen name="return" options={{ title: "Return and sign off" }} />
  <Stack.Screen name="sync" options={{ title: "Pending updates" }} />
  <Stack.Screen name="updates" options={{ title: "Updates" }} />
  <Stack.Screen name="diagnostics" options={{ title: "App details" }} />
</Stack></WorkflowProvider>; }
