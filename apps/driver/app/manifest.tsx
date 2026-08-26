import { Link } from "expo-router";
import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { StatusCard } from "../src/components/StatusCard";
export default function ManifestScreen() { return <FeasibilityScreen title="Synthetic manifest" summary="Downloaded minimum-necessary service-day projection.">
  <StatusCard title="Stop 1" status="Scheduled"><Text>Synthetic Civic Center · 08:00</Text><Link href="/stop/ref_synthetic_stop_0001">Open stop detail</Link></StatusCard>
</FeasibilityScreen>; }
