import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { FeasibilityScreen } from "../../src/components/FeasibilityScreen";
export default function StopDetailScreen() { const { reference } = useLocalSearchParams<{ reference: string }>(); const safe = /^ref_synthetic_stop_[0-9]{4}$/.test(reference ?? "");
  return <FeasibilityScreen title="Stop detail" summary={safe ? "Synthetic destination and permitted action." : "Invalid opaque stop reference."}><Text>{safe ? "Synthetic Civic Center" : "No stop loaded"}</Text></FeasibilityScreen>; }
