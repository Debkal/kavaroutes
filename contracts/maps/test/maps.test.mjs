import test from "node:test";
import assert from "node:assert/strict";
import {
  accountAutocomplete,accountMapLoads,accountMatrix,accountOptimization,admitRequest,calculateProfileCost,canonicalJson,classifySku,evaluateCache,evaluateDisplay,manualFallback,normalizeBundle,priceSku,providerAuthority,validateAdmission,validateBundle,validateControlledTotals,validateCredentials,validateDegradation,validateGolden,validateProviderRequest,validateStorage,validateTelemetry
} from "../lib/contracts.mjs";
import { loadBundle, loadProfiles } from "../scripts/load.mjs";

const bundle=await loadBundle(),profiles=await loadProfiles();
const costs=profiles.map((profile)=>calculateProfileCost(profile,bundle.costModel,bundle.pricing));
const profile=(id)=>profiles.find((x)=>x.id===id),sku=(id)=>bundle.pricing.skus.find((x)=>x.id===id);
const safeRoute=()=>({operation:"ROUTE",apiVersion:"v2",origin:{address:"SYNTHETIC_ORIGIN_ALPHA"},destination:{coordinates:{latitude:"SYNTHETIC_LAT_ALPHA",longitude:"SYNTHETIC_LNG_ALPHA"}},travelMode:"DRIVE",routingPreference:"TRAFFIC_AWARE",fieldMask:["routes.distanceMeters","routes.duration"]});

test("bundle and four controlled profiles validate",()=>{assert.doesNotThrow(()=>validateBundle(bundle));assert.doesNotThrow(()=>validateControlledTotals(costs,bundle.costModel));});

test("controlled P0 totals reproduce ARQ-004 exactly",()=>{
  assert.deepEqual(costs.map((x)=>({id:x.profileId,monthly:x.monthly,vehicle:x.perActiveVehicle,trip:x.perTrip})),[
    {id:"small-pilot",monthly:105.66,vehicle:4.23,trip:0.007},{id:"p0-growth",monthly:497.33,vehicle:6.63,trip:0.0111},{id:"enterprise-design",monthly:4097.5,vehicle:8.2,trip:0.0137},{id:"commercial-platform",monthly:25602.7,vehicle:5.12,trip:0.0085}
  ]);
});

test("SKU free caps and volume tiers apply independently",()=>{
  assert.equal(priceSku(10000,sku("GEOCODING"),bundle.pricing),0);
  assert.equal(priceSku(11000,sku("GEOCODING"),bundle.pricing),5);
  assert.equal(priceSku(11000,sku("DYNAMIC_MAPS"),bundle.pricing),7);
  assert.equal(priceSku(6000,sku("COMPUTE_ROUTES_PRO"),bundle.pricing),10);
});

test("changed dated price input changes output without changing workload fixtures",()=>{
  const changed=structuredClone(bundle.pricing);changed.skus.find((x)=>x.id==="COMPUTE_MATRIX_PRO").rates[0]=11;
  const before=canonicalJson(profile("small-pilot")),result=calculateProfileCost(profile("small-pilot"),bundle.costModel,changed);
  assert.equal(result.monthly,115.66);assert.equal(canonicalJson(profile("small-pilot")),before);
});

test("matrix volume is origins times destinations",()=>{assert.deepEqual(accountMatrix({origins:3,destinations:4}),{billableUnits:12,unit:"MATRIX_ELEMENT",reason:"ORIGINS_TIMES_DESTINATIONS"});});

test("fleet optimization bills shipments rather than vehicles or requests",()=>{
  assert.deepEqual(accountOptimization({vehicles:3,shipments:10}),{skuId:"OPTIMIZATION_FLEET",billableUnits:10,unit:"SHIPMENT",reason:"TWO_OR_MORE_VEHICLES_FLEET_SKU"});
  assert.equal(accountOptimization({vehicles:1,shipments:10}).skuId,"OPTIMIZATION_SINGLE_VEHICLE");
});

test("navigation and optimization sensitivity increments reproduce ARQ-004",()=>{
  const expectedFleet=[870,2670,9170,23270],expectedNav=[725,2225,11975,51975];
  profiles.forEach((p,i)=>{const base=calculateProfileCost(p,bundle.costModel,bundle.pricing).monthly;const fleet=calculateProfileCost(p,bundle.costModel,bundle.pricing,{optimizationShipmentsPerLegPerServiceDayP0:1}).monthly;const nav=calculateProfileCost(p,bundle.costModel,bundle.pricing,{navigationDestinationsPerLegPerServiceDayP0:1}).monthly;assert.equal(Math.round((fleet-base)*100)/100,expectedFleet[i]);assert.equal(Math.round((nav-base)*100)/100,expectedNav[i]);});
});

test("map marker updates do not create map loads",()=>{assert.deepEqual(accountMapLoads({mapInitializations:1,markerUpdates:500}),{billableUnits:1,unit:"MAP_LOAD",reason:"MARKER_UPDATES_DO_NOT_RELOAD_BASE_MAP"});});

test("successful and abandoned autocomplete sessions account differently",()=>{
  assert.deepEqual(accountAutocomplete({requests:14,terminatedWithDetailsEssentials:true}),{autocompleteRequestUnits:12,sessionUsageUnits:2,detailsUnits:1,reason:"SUCCESS_AFTER_TWELVE"});
  assert.deepEqual(accountAutocomplete({requests:14,terminatedWithDetailsEssentials:false}),{autocompleteRequestUnits:14,sessionUsageUnits:0,detailsUnits:0,reason:"ABANDONED_ALL_REQUESTS_BILLABLE"});
});

test("subscription comparison is explicit and excludes fleet/navigation",()=>{const result=costs[0];assert.equal(result.subscriptions.length,3);assert.equal(result.subscriptions[0].id,"SUB_50K");assert.equal(bundle.pricing.subscriptions[0].excludedSkus.includes("OPTIMIZATION_FLEET"),true);});

test("typed minimal route request passes the synthetic policy without making a call",()=>{assert.deepEqual(validateProviderRequest(safeRoute(),bundle.manifests),{decision:"ALLOW_SYNTHETIC_CONTRACT",reason:"TYPED_ALLOWLIST_PASSED",providerCallMade:false});});

test("identity, health, payer, billing, internal IDs, labels, and metadata fail before egress",()=>{
  for(const field of ["riderName","appointmentPurpose","claimId","billingData","tenantId","tripId","driverId","label","customMetadata"]){const request=safeRoute();request[field]="SYNTHETIC_REJECT_CANARY";const result=validateProviderRequest(request,bundle.manifests);assert.equal(result.decision,"REJECT",field);assert.equal(result.providerCallMade,false,field);}
});

test("unknown top-level and nested fields fail closed",()=>{
  assert.equal(validateProviderRequest({...safeRoute(),mystery:"SYNTHETIC"},bundle.manifests).reason,"UNKNOWN_MAPS_FIELD");
  const nested=safeRoute();nested.origin.arbitraryMetadata="SYNTHETIC";assert.equal(validateProviderRequest(nested,bundle.manifests).reason,"UNKNOWN_MAPS_FIELD");
});

test("nested internal identifiers fail closed",()=>{const request=safeRoute();request.origin.tripId="syn_trip_1";assert.equal(validateProviderRequest(request,bundle.manifests).reason,"MAPS_PRIVACY_FIELD_REJECTED");});

test("missing and wildcard field masks fail closed",()=>{
  const missing=safeRoute();delete missing.fieldMask;assert.equal(validateProviderRequest(missing,bundle.manifests).reason,"REQUIRED_MAPS_FIELD_MISSING");
  const wildcard=safeRoute();wildcard.fieldMask=["*"];assert.equal(validateProviderRequest(wildcard,bundle.manifests).reason,"WILDCARD_OR_MISSING_FIELD_MASK");
});

test("field masks and traffic preferences classify Essentials versus Pro",()=>{
  assert.equal(classifySku({operation:"ROUTE",routingPreference:"TRAFFIC_AWARE",fieldMask:["routes.duration"]}).skuId,"COMPUTE_ROUTES_PRO");
  assert.equal(classifySku({operation:"ROUTE",routingPreference:"TRAFFIC_UNAWARE",fieldMask:["routes.duration"]}).skuId,"COMPUTE_ROUTES_ESSENTIALS");
  assert.equal(classifySku({operation:"MATRIX",routingPreference:"TRAFFIC_AWARE_OPTIMAL",fieldMask:["duration"]}).skuId,"COMPUTE_MATRIX_PRO");
});

test("unknown field tier and unknown routing preference are rejected",()=>{
  assert.equal(classifySku({operation:"ROUTE",routingPreference:"TRAFFIC_UNAWARE",fieldMask:["routes.tollInfo"]}).reason,"UNKNOWN_FIELD_OR_SKU_TIER");
  assert.equal(classifySku({operation:"ROUTE",routingPreference:"MAGICAL",fieldMask:["routes.duration"]}).decision,"REJECT");
});

test("safe telemetry allowlist rejects addresses, coordinates, responses, and rejected values",()=>{
  assert.equal(validateTelemetry(["operationId","skuId","billableUnits"],bundle.manifests).decision,"ALLOW");
  for(const field of ["address","coordinates","providerResponseBody","rejectedValue"])assert.equal(validateTelemetry(["operationId",field],bundle.manifests).decision,"REJECT");
});

test("expired provider cache cannot delete customer address or KavaRoutes evidence",()=>{assert.deepEqual(evaluateCache({obtainedAt:"2026-07-01T00:00:00Z",evaluationAt:"2026-08-01T00:00:01Z",maxAgeDays:30}),{decision:"REJECT",reason:"PROVIDER_CONTENT_EXPIRED",deleteCustomerAddress:false,deleteKavaRoutesEvidence:false});});

test("storage policy keeps Place IDs durable and derived content at a 30-day default",()=>{assert.doesNotThrow(()=>validateStorage(bundle.storage,bundle.sources));const cache=bundle.storage.records.find((x)=>x.id==="LICENSED_PROVIDER_CACHE");assert.equal(cache.maxAge.value,30);});

test("invalid content and map pairing or missing attribution fails",()=>{
  assert.equal(evaluateDisplay({content:"GOOGLE_CONTENT",surface:"NON_GOOGLE_MAP",attributionRendered:true}).reason,"CONTENT_MAP_MISMATCH");
  assert.equal(evaluateDisplay({content:"GOOGLE_CONTENT",surface:"GOOGLE_MAP",attributionRendered:false}).reason,"ATTRIBUTION_REQUIRED");
  assert.equal(evaluateDisplay({content:"GOOGLE_CONTENT",surface:"GOOGLE_MAP",attributionRendered:true}).decision,"ALLOW");
});

test("provider output never becomes execution, assignment, service, or billing authority",()=>{assert.deepEqual(providerAuthority(),{decision:"REJECT",reason:"PROVIDER_OUTPUT_NOT_DOMAIN_AUTHORITY",authoritativeStateChanged:false});});

test("over-budget, unknown-SKU, cross-tenant, and missing-unit admissions fail closed",()=>{
  const base={tenantId:"syn_tenant_alpha",operation:"MATRIX",skuId:"COMPUTE_MATRIX_PRO",estimatedUnits:12,tenantUsedUnits:0,projectDailyUsedUnits:0};
  assert.equal(admitRequest({...base,tenantUsedUnits:249995},bundle.admission,bundle.pricing).reason,"TENANT_MONTHLY_UNIT_CEILING_EXCEEDED");
  assert.equal(admitRequest({...base,skuId:"UNKNOWN"},bundle.admission,bundle.pricing).reason,"UNKNOWN_SKU");
  assert.equal(admitRequest({...base,ledgerTenantId:"syn_tenant_beta"},bundle.admission,bundle.pricing).reason,"CROSS_TENANT_LEDGER_REFERENCE");
  assert.equal(admitRequest({...base,estimatedUnits:0},bundle.admission,bundle.pricing).reason,"BILLABLE_UNITS_REQUIRED");
});

test("budget alerts cannot masquerade as hard caps",()=>{const invalid=structuredClone(bundle.admission);invalid.budgetAlertsAreHardCaps=true;assert.throws(()=>validateAdmission(invalid,bundle.pricing),/alerts and hard caps/);});

test("credential topology contains no values and remains human-gated",()=>{assert.doesNotThrow(()=>validateCredentials(bundle.credentials));const invalid=structuredClone(bundle.credentials);invalid.credentialClasses[0].value="SYNTHETIC_SECRET_SHAPED_CANARY";assert.throws(()=>validateCredentials(invalid),/credential value/);});

test("manual fallback preserves assignment and requires hard constraints",()=>{
  assert.deepEqual(manualFallback({failure:"MATRIX_UNAVAILABLE_OR_OVER_BUDGET",priorAssignment:"syn_assignment_1",hardConstraintsPassed:true}),{decision:"MANUAL_ACTION_ELIGIBLE",reason:"PRIOR_ASSIGNMENT_PRESERVED_AND_HARD_RULES_PASSED",authoritativeStateChanged:false});
  assert.equal(manualFallback({failure:"MATRIX_UNAVAILABLE_OR_OVER_BUDGET",hardConstraintsPassed:false}).decision,"REJECT");
});

test("all eight degradation scenarios preserve authoritative state",()=>{assert.doesNotThrow(()=>validateDegradation(bundle.degradation));assert.equal(bundle.degradation.scenarios.length,8);});

test("all golden examples match independent calculators and policies",()=>{assert.doesNotThrow(()=>validateGolden(bundle.golden,bundle));assert.equal(bundle.golden.examples.length,17);});

test("mutated golden accounting fails deterministic validation",()=>{const invalid=structuredClone(bundle.golden);invalid.examples.find((x)=>x.id==="GOLDEN_MATRIX_ELEMENTS").expected.billableUnits=7;assert.throws(()=>validateGolden(invalid,bundle),/GOLDEN_MATRIX_ELEMENTS/);});

test("same seed, price version, workload, and inputs produce byte-equivalent output",()=>{assert.equal(canonicalJson(normalizeBundle(bundle,profiles)),canonicalJson(normalizeBundle(structuredClone(bundle),structuredClone(profiles))));});

test("normalized output explicitly records zero provider API calls and no credentials",()=>{const normalized=normalizeBundle(bundle,profiles);assert.equal(normalized.providerApiCallsMade,0);assert.equal(normalized.credentialValuesPresent,false);assert.ok(normalized.limitations.includes("NO_PROVIDER_API_CALL_OR_CREDENTIAL"));});
