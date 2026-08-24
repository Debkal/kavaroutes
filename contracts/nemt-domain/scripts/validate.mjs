import { validateBundle } from "../lib/contracts.mjs";
import { loadBundle } from "./load.mjs";

const bundle = validateBundle(await loadBundle());
const transitions = bundle.machines.machines.reduce((sum, machine) => sum + machine.transitions.length, 0);
const prohibitions = bundle.machines.machines.reduce((sum, machine) => sum + machine.explicitProhibitions.length, 0);
console.log(`Validated ${bundle.glossary.terms.length} terms, ${bundle.aggregates.aggregates.length} aggregates, ${bundle.machines.machines.length} state machines, ${transitions} transitions, ${prohibitions} explicit prohibitions, ${bundle.catalog.commands.length} commands, ${bundle.constraints.constraints.length} constraints, and ${bundle.scenarios.scenarios.length} golden scenarios.`);
