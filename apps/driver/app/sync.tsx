import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { StatusCard } from "../src/components/StatusCard";
export default function SyncScreen() { return <FeasibilityScreen title="Sync and recovery" summary="Cursor advances only after durable local apply."><StatusCard title="Connection" status="DISCONNECTED" /><StatusCard title="Offline queue" status="PENDING" /></FeasibilityScreen>; }
