import { useState } from "react";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { useWorkflow } from "../src/workflow-context";
export default function ManifestScreen() {
  const [range, setRange] = useState<"DAY" | "TOMORROW" | "WEEK">("DAY"); const { state } = useWorkflow();
  if (state.moving) return <FeasibilityScreen title="Itinerary locked while moving" summary="For safety, the full route is available again when the vehicle is parked."><StatusCard title="Available now" status="Active directions and emergency stop only" /></FeasibilityScreen>;
  return <FeasibilityScreen title="Your itinerary" summary="Day is the working view. Tomorrow and Week are read-only planning views.">
    <PrimaryButton label="Day" disabled={range === "DAY"} onPress={() => setRange("DAY")} /><PrimaryButton label="Tomorrow · read only" disabled={range === "TOMORROW"} onPress={() => setRange("TOMORROW")} /><PrimaryButton label="Week · read only" disabled={range === "WEEK"} onPress={() => setRange("WEEK")} />
    {range !== "DAY" ? <StatusCard title={range === "TOMORROW" ? "Tomorrow" : "This week"} status="No additional synthetic assignments"><Text>Planning only. Changes are not available here.</Text></StatusCard> : <>
      <StatusCard title="Pull-out · 7:40 AM" status="Completed" />
      <StatusCard title="P1 · Pickup · 8:00–8:15 AM" status={state.currentNode > 0 ? "Completed" : "Current"}><Text>Synthetic Rider A · 1 companion · grouped load rider 1 of 2</Text><Text>Wheelchair · lift · securement · reviewed driver-visible mobility note</Text></StatusCard>
      <StatusCard title="P2 · Pickup · 8:12–8:27 AM" status={state.currentNode > 1 ? "Completed" : state.currentNode === 1 ? "Current" : "Pending"}><Text>Synthetic Rider B · grouped load rider 2 of 2 · door-to-door assistance</Text></StatusCard>
      <StatusCard title="D1 · Drop-off · 8:35–8:50 AM" status={state.currentNode > 2 ? "Completed" : state.currentNode === 2 ? "Current" : "Pending"}><Text>Demo Community Center · individual evidence required</Text></StatusCard>
      <StatusCard title="D2 · Drop-off · 8:48–9:03 AM" status={state.stopStep === "COMPLETE" ? "Completed" : state.currentNode === 3 ? "Current" : "Pending"}><Text>Demo Arts Center · individual evidence required</Text></StatusCard>
      <StatusCard title="Return / pull-in · 9:05 AM" status="Pending" /><StatusCard title="Post-check and sign-off" status="Pending" />
    </>}
  </FeasibilityScreen>;
}
