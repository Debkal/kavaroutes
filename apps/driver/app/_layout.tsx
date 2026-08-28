import "../src/background-location";
import { Stack } from "expo-router";
import { WorkflowProvider } from "../src/workflow-context";
export default function RootLayout() { return <WorkflowProvider><Stack screenOptions={{ headerBackTitle: "Back", animation: "none" }}>
  <Stack.Screen name="index" options={{ title: "My shift" }} />
  <Stack.Screen name="manifest" options={{ title: "Today's stops" }} />
  <Stack.Screen name="stop/[reference]" options={{ title: "Stop details" }} />
  <Stack.Screen name="inspection" options={{ title: "Vehicle check" }} />
  <Stack.Screen name="signature" options={{ title: "Signature" }} />
  <Stack.Screen name="proposal" options={{ title: "Route change" }} />
  <Stack.Screen name="return" options={{ title: "Return and sign off" }} />
  <Stack.Screen name="sync" options={{ title: "Pending updates" }} />
  <Stack.Screen name="diagnostics" options={{ title: "App details" }} />
</Stack></WorkflowProvider>; }
