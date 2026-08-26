import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { StatusCard } from "../src/components/StatusCard";
export default function SignatureScreen() { return <FeasibilityScreen title="Synthetic signature" summary="A local draft is not identity, consent, proof, or server acceptance."><StatusCard title="Draft" status="Not captured"><Text>Capture surface intentionally synthetic.</Text></StatusCard></FeasibilityScreen>; }
