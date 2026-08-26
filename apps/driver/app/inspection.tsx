import { TextInput } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
export default function InspectionScreen() { return <FeasibilityScreen title="Inspection draft" summary="Encrypted local draft; not accepted evidence."><TextInput accessibilityLabel="Synthetic odometer check" placeholder="Synthetic value" /></FeasibilityScreen>; }
