import { Text } from "react-native";
import { FeasibilityScreen } from "../src/components/FeasibilityScreen";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { StatusCard } from "../src/components/StatusCard";
import { useWorkflow } from "../src/workflow-context";
export default function ProposalScreen() { const { state, dispatch } = useWorkflow();
  if (state.moving) return <FeasibilityScreen title="Route changes unavailable while moving" summary="Park safely before reviewing future stops." />;
  if (!state.effectivePolicy || state.effectivePolicy.routeChange.mode === "DISABLED") return <FeasibilityScreen title="Route changes unavailable" summary="The server-pinned policy disables driver route proposals for this shift. The Driver cannot change that setting." />;
  return <FeasibilityScreen title="Propose a route change" summary="Only eligible future, unlocked stops can be reordered. The itinerary does not change until a synthetic server receipt accepts it.">
    <StatusCard title={`${state.effectivePolicy.commercialTier.replaceAll("_", " ")} · ${state.effectivePolicy.workforceRelationship.replaceAll("_", " ")}`} status={state.proposalState}><Text>{state.effectivePolicy.routeChange.mode === "AUTHORIZED_SELF_APPROVE" ? "The accepted policy permits validated self-approval for this assigned principal." : "A valid proposal remains pending until an authorized dispatcher decides it."}</Text><Text>Policy v{state.effectivePolicy.policyVersion} · {state.effectivePolicy.canonicalDigest.slice(0, 12)}…</Text></StatusCard>
    <PrimaryButton label="Create local route draft" onPress={() => dispatch({ type: "BEGIN_PROPOSAL" })} /><PrimaryButton label="Submit valid future-stop reorder" disabled={state.proposalState !== "DRAFT"} onPress={() => dispatch({ type: "PROPOSE_REORDER" })} />
    <PrimaryButton label="Test invalid pickup/drop-off inversion" disabled={state.proposalState !== "DRAFT"} onPress={() => dispatch({ type: "PROPOSE_REORDER", violation: "PICKUP_DROPOFF_INVERSION" })} />
    {state.proposalState === "PENDING_DISPATCH_APPROVAL" ? <StatusCard title="Dispatch decision" status="Pending"><Text>Approval is intentionally unavailable to the Driver principal. Sync will apply only an authorized server receipt.</Text></StatusCard> : null}
    <StatusCard title="Protected invariants" status="Always checked"><Text>No rider, address, service, payer, driver, started/locked node, capacity, equipment, qualification, time-window, ride-time, break, or return rule can be changed here.</Text></StatusCard>
  </FeasibilityScreen>; }
