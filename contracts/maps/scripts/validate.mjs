import { calculateProfileCost, validateBundle, validateControlledTotals } from "../lib/contracts.mjs";
import { loadBundle, loadProfiles } from "./load.mjs";

const bundle=validateBundle(await loadBundle()),profiles=await loadProfiles();
const results=profiles.map((profile)=>calculateProfileCost(profile,bundle.costModel,bundle.pricing));
validateControlledTotals(results,bundle.costModel);
console.log(`Validated ${bundle.capabilities.capabilities.length} capabilities, ${bundle.pricing.skus.length} SKUs, ${bundle.manifests.manifests.length} request manifests, ${bundle.degradation.scenarios.length} degradation scenarios, ${bundle.golden.examples.length} golden examples, and ${results.length} controlled cost profiles.`);
for(const result of results)console.log(`${result.profileId}: $${result.monthly.toFixed(2)} monthly, $${result.perActiveVehicle.toFixed(2)}/vehicle, $${result.perTrip.toFixed(4)}/trip`);
