import { Pressable, Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { StatusCard } from "../src/components/StatusCard";
export default function ActionScreen() { return <FeasibilityScreen title="Driver action" summary="The action is queued with stable identity and remains pending until server acceptance.">
  <StatusCard title="Arrival" status="Not submitted" /><Pressable accessibilityRole="button" accessibilityState={{ disabled: false }}><Text>Queue synthetic arrival</Text></Pressable>
</FeasibilityScreen>; }
