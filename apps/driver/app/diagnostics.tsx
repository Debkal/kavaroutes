import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
export default function DiagnosticsScreen() { return <FeasibilityScreen title="Safe diagnostics" summary="Low-cardinality synthetic metadata only."><Text>Environment: synthetic-local</Text><Text>Location values: excluded</Text><Text>Manifest content: excluded</Text></FeasibilityScreen>; }
