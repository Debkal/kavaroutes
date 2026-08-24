import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const REQUIRED_SKUS=["AUTOCOMPLETE_REQUESTS","AUTOCOMPLETE_SESSION_USAGE","PLACE_DETAILS_ESSENTIALS","PLACE_DETAILS_IDS_ONLY","GEOCODING","DYNAMIC_MAPS","MAPS_SDK","COMPUTE_ROUTES_ESSENTIALS","COMPUTE_MATRIX_ESSENTIALS","COMPUTE_ROUTES_PRO","COMPUTE_MATRIX_PRO","OPTIMIZATION_SINGLE_VEHICLE","OPTIMIZATION_FLEET","NAVIGATION_REQUEST"];
const REQUIRED_OPERATIONS=["ADDRESS_AUTOCOMPLETE","ADDRESS_SELECTION","GEOCODE","ROUTE","MATRIX","OPTIMIZE"];
const REQUIRED_DEGRADATIONS=["ADDRESS_SERVICE_UNAVAILABLE","ROUTE_UNAVAILABLE","MATRIX_UNAVAILABLE_OR_OVER_BUDGET","OPTIMIZER_UNAVAILABLE_OR_INFEASIBLE","DYNAMIC_MAP_UNAVAILABLE","RATE_LIMIT_OR_QUOTA","PRIVACY_POLICY_REJECTION","CREDENTIAL_ABUSE_OR_UNKNOWN_SKU"];
const REQUIRED_GOLDEN_TYPES=["AUTOCOMPLETE_ACCOUNTING","MATRIX_ACCOUNTING","OPTIMIZATION_ACCOUNTING","FIELD_TIER","CACHE_EXPIRY","DISPLAY_PAIRING","REQUEST_PRIVACY","SAFE_TELEMETRY","COST_ADMISSION","MANUAL_FALLBACK","MAP_LOAD_ACCOUNTING","AUTHORITY"];

function fail(path,message){throw new Error(`${path}: ${message}`)}
function object(value,path){if(!value||typeof value!=="object"||Array.isArray(value))fail(path,"must be an object")}
function array(value,path){if(!Array.isArray(value))fail(path,"must be an array")}
function string(value,path){if(typeof value!=="string"||!value.trim())fail(path,"must be a non-empty string")}
function unique(items,key,path){const seen=new Set();for(const [i,item] of items.entries()){string(item[key],`${path}[${i}].${key}`);if(seen.has(item[key]))fail(`${path}[${i}].${key}`,`duplicate ${item[key]}`);seen.add(item[key])}}
function exact(actual,expected,path){if(canonicalJson([...actual].sort())!==canonicalJson([...expected].sort()))fail(path,`must contain exactly ${expected.join(", ")}`)}
function round(value,places){const factor=10**places;return Math.round((value+Number.EPSILON)*factor)/factor}

export function canonicalJson(value){const sort=(item)=>Array.isArray(item)?item.map(sort):item&&typeof item==="object"?Object.fromEntries(Object.keys(item).sort().map((key)=>[key,sort(item[key])])):item;return `${JSON.stringify(sort(value),null,2)}\n`}
export function digest(value){return createHash("sha256").update(canonicalJson(value)).digest("hex")}
export async function readJson(path){return JSON.parse(await readFile(path,"utf8"))}

export function validateSources(registry){
  object(registry,"sources");array(registry.sources,"sources.sources");unique(registry.sources,"id","sources.sources");
  for(const [i,source] of registry.sources.entries())for(const key of ["title","url","accessed","authority"])string(source[key],`sources.sources[${i}].${key}`);
  return registry;
}

export function validatePricing(pricing,sources){
  object(pricing,"pricing");
  for(const key of ["priceVersion","effectiveDate","provider","apiVersion","pricingRegion","currency","priceUnit","sourceId","status"])string(pricing[key],`pricing.${key}`);
  if(!sources.sources.some((x)=>x.id===pricing.sourceId))fail("pricing.sourceId","unknown source");
  if(pricing.currency!=="USD"||pricing.pricingRegion!=="GLOBAL")fail("pricing","controlled model requires dated global USD inputs");
  array(pricing.tierUpperBounds,"pricing.tierUpperBounds");array(pricing.skus,"pricing.skus");unique(pricing.skus,"id","pricing.skus");
  exact(pricing.skus.map((x)=>x.id),REQUIRED_SKUS,"pricing.skus");
  for(const [i,sku] of pricing.skus.entries()){
    const path=`pricing.skus[${i}]`;for(const key of ["category","billableUnit"])string(sku[key],`${path}.${key}`);
    if(!(sku.freeCap===null||(Number.isInteger(sku.freeCap)&&sku.freeCap>=0)))fail(`${path}.freeCap`,"must be null or a non-negative integer");
    if(!Array.isArray(sku.rates)||sku.rates.length!==pricing.tierUpperBounds.length||sku.rates.some((x)=>typeof x!=="number"||x<0))fail(`${path}.rates`,"must align to non-negative tier rates");
  }
  for(const sub of pricing.subscriptions){if(!(sub.monthlyPrice>0&&sub.includedEvents>0))fail(`pricing.subscriptions.${sub.id}`,"price and included events required")}
  return pricing;
}

export function priceSku(units,sku,pricing){
  if(!Number.isFinite(units)||units<0)fail("units","must be a non-negative number");
  if(!sku)fail("sku","unknown SKU");
  if(sku.freeCap===null)return 0;
  let previous=sku.freeCap,total=0;
  if(units<=previous)return 0;
  for(let index=0;index<pricing.tierUpperBounds.length;index+=1){
    const upper=pricing.tierUpperBounds[index]??Infinity;
    const tierUnits=Math.max(0,Math.min(units,upper)-previous);
    total+=tierUnits*sku.rates[index]/1000;
    previous=upper;
    if(units<=upper)break;
  }
  return round(total,6);
}

export function deriveP0Volumes(profile,model,overrides={}){
  const a={...model.assumptions,...overrides},days=model.serviceDaysPerMonth,d=profile.dimensions;
  const monthlyTrips=d.trips.value*days,monthlyLegs=d.legs.value*days;
  return {
    AUTOCOMPLETE_REQUESTS:monthlyTrips*a.interactiveAddressSelectionsPerTrip*a.autocompleteRequestsPerSelection,
    PLACE_DETAILS_ESSENTIALS:monthlyTrips*a.interactiveAddressSelectionsPerTrip*a.detailsRequestsPerSuccessfulSelection*a.successfulSelectionRate,
    GEOCODING:monthlyTrips*a.serverGeocodesPerTrip,
    DYNAMIC_MAPS:d.webUsers.value*days*a.dynamicMapLoadsPerWebUserPerServiceDay,
    COMPUTE_ROUTES_PRO:d.activeVehicles.value*days*a.routesProPerVehiclePerServiceDay,
    COMPUTE_MATRIX_PRO:monthlyLegs*a.matrixProElementsPerLegPerServiceDay,
    OPTIMIZATION_FLEET:monthlyLegs*a.optimizationShipmentsPerLegPerServiceDayP0,
    NAVIGATION_REQUEST:monthlyLegs*a.navigationDestinationsPerLegPerServiceDayP0
  };
}

export function calculateProfileCost(profile,model,pricing,overrides={}){
  const volumes=deriveP0Volumes(profile,model,overrides),skuMap=new Map(pricing.skus.map((x)=>[x.id,x])),breakdown={};let monthly=0;
  for(const [skuId,units] of Object.entries(volumes)){const cost=priceSku(units,skuMap.get(skuId),pricing);breakdown[skuId]={units,billableUnit:skuMap.get(skuId).billableUnit,cost};monthly+=cost}
  monthly=round(monthly,2);
  const monthlyTrips=profile.dimensions.trips.value*model.serviceDaysPerMonth;
  const includedEvents=Object.entries(volumes).filter(([id])=>!pricing.subscriptions[0].excludedSkus.includes(id)).reduce((sum,[,units])=>sum+units,0);
  const subscriptions=pricing.subscriptions.map((sub)=>({id:sub.id,monthlyPrice:sub.monthlyPrice,includedEvents:sub.includedEvents,modeledIncludedUsage:includedEvents,eligibleByEventCap:includedEvents<=sub.includedEvents,deltaFromPayAsYouGo:round(sub.monthlyPrice-monthly,2)}));
  return {profileId:profile.id,priceVersion:pricing.priceVersion,modelVersion:model.modelVersion,monthly,perTenant:round(monthly/profile.dimensions.tenants.value,2),perActiveVehicle:round(monthly/profile.dimensions.activeVehicles.value,2),perTrip:round(monthly/monthlyTrips,4),volumes,breakdown,subscriptions};
}

export function validateControlledTotals(results,model){
  for(const expected of model.expectedControlledTotals){const actual=results.find((x)=>x.profileId===expected.profileId);if(!actual)fail("controlledTotals",`missing ${expected.profileId}`);for(const key of ["monthly","perActiveVehicle","perTrip"])if(Math.abs(actual[key]-expected[key])>0.000001)fail(`controlledTotals.${expected.profileId}.${key}`,`expected ${expected[key]}, got ${actual[key]}`)}
  return results;
}

export function validateCapabilities(registry,pricing,sources){
  object(registry,"capabilities");array(registry.capabilities,"capabilities.capabilities");unique(registry.capabilities,"id","capabilities.capabilities");
  const skus=new Set(pricing.skus.map((x)=>x.id)),sourceIds=new Set(sources.sources.map((x)=>x.id));
  for(const [i,item] of registry.capabilities.entries()){const path=`capabilities.capabilities[${i}]`;for(const key of ["phase","decision","billableUnit","fieldEscalation","productionGate"])string(item[key],`${path}.${key}`);if(!item.skus?.length||item.skus.some((id)=>!skus.has(id)))fail(`${path}.skus`,"unknown or missing SKU");if(!item.sourceIds?.length||item.sourceIds.some((id)=>!sourceIds.has(id)))fail(`${path}.sourceIds`,"unknown or missing source")}
  return registry;
}

export function validateManifests(registry,pricing){
  object(registry,"manifests");array(registry.manifests,"manifests.manifests");unique(registry.manifests,"operation","manifests.manifests");exact(registry.manifests.map((x)=>x.operation),REQUIRED_OPERATIONS,"manifests.operations");
  const skus=new Set(pricing.skus.map((x)=>x.id));
  for(const [i,item] of registry.manifests.entries()){const path=`manifests.manifests[${i}]`;for(const key of ["allowedFields","requiredFields","fieldMask","allowedSkus","resultFields"])if(!Array.isArray(item[key])||!item[key].length)fail(`${path}.${key}`,"must be a non-empty array");if(item.allowedSkus.some((id)=>!skus.has(id)))fail(`${path}.allowedSkus`,"unknown SKU");if(item.fieldMask.includes("*"))fail(`${path}.fieldMask`,"wildcard mask forbidden")}
  if(registry.unknownFieldPolicy!=="REJECT_BEFORE_EGRESS"||registry.domainAggregateSerialization!=="FORBIDDEN")fail("manifests","unknown fields and aggregate serialization must fail closed");
  return registry;
}

export function validateProviderRequest(request,manifests){
  object(request,"request");const manifest=manifests.manifests.find((x)=>x.operation===request.operation);if(!manifest)return{decision:"REJECT",reason:"UNKNOWN_MAPS_OPERATION",providerCallMade:false};
  const nestedAllowed=new Set(["address","coordinates","placeId","latitude","longitude","center","radiusMeters","rectangle","low","high","avoidTolls","avoidHighways","avoidFerries","addressLines","locality","administrativeArea","postalCode","regionCode","pickups","deliveries","loadDemands","timeWindows","serviceDuration","startLocation","endLocation","capacity","labelFreeConstraintId","amount","unit","startTime","endTime"]);
  const nestedKeys=[];const visit=(value,top=false)=>{if(Array.isArray(value)){value.forEach((item)=>visit(item,false));return}if(value&&typeof value==="object")for(const [key,child] of Object.entries(value)){if(!top)nestedKeys.push(key);visit(child,false)}};visit(request,true);
  const fields=Object.keys(request);const prohibited=[...fields,...nestedKeys].filter((field)=>manifests.prohibitedFields.includes(field)||(/Id$/i.test(field)&&field!=="placeId"));if(prohibited.length)return{decision:"REJECT",reason:"MAPS_PRIVACY_FIELD_REJECTED",rejectedFieldIds:[...new Set(prohibited)].sort(),providerCallMade:false};
  const unknown=fields.filter((field)=>!manifest.allowedFields.includes(field));if(unknown.length)return{decision:"REJECT",reason:"UNKNOWN_MAPS_FIELD",rejectedFieldIds:unknown.sort(),providerCallMade:false};
  const unknownNested=nestedKeys.filter((field)=>!nestedAllowed.has(field));if(unknownNested.length)return{decision:"REJECT",reason:"UNKNOWN_MAPS_FIELD",rejectedFieldIds:[...new Set(unknownNested)].sort(),providerCallMade:false};
  const missing=manifest.requiredFields.filter((field)=>request[field]===undefined);if(missing.length)return{decision:"REJECT",reason:"REQUIRED_MAPS_FIELD_MISSING",rejectedFieldIds:missing.sort(),providerCallMade:false};
  if(!Array.isArray(request.fieldMask)||!request.fieldMask.length||request.fieldMask.includes("*"))return{decision:"REJECT",reason:"WILDCARD_OR_MISSING_FIELD_MASK",providerCallMade:false};
  if(request.fieldMask.some((field)=>!manifest.fieldMask.includes(field)))return{decision:"REJECT",reason:"UNAPPROVED_FIELD_MASK",providerCallMade:false};
  const serialized=JSON.stringify(request);if(/"(tenant|rider|trip|leg|run|assignment|driver|vehicle)Id"/i.test(serialized))return{decision:"REJECT",reason:"INTERNAL_IDENTIFIER_REJECTED",providerCallMade:false};
  return{decision:"ALLOW_SYNTHETIC_CONTRACT",reason:"TYPED_ALLOWLIST_PASSED",providerCallMade:false};
}

export function classifySku(request){
  if(request.fieldMask?.includes("*"))return{skuId:null,decision:"REJECT",reason:"WILDCARD_FIELD_MASK_FORBIDDEN"};
  const allowedRoute=new Set(["routes.distanceMeters","routes.duration","routes.polyline.encodedPolyline","routes.viewport","routes.warnings"]),allowedMatrix=new Set(["originIndex","destinationIndex","status","distanceMeters","duration","condition"]);
  if(request.operation==="ROUTE"){if(request.fieldMask?.some((x)=>!allowedRoute.has(x))||!["TRAFFIC_UNAWARE","TRAFFIC_AWARE","TRAFFIC_AWARE_OPTIMAL"].includes(request.routingPreference))return{skuId:null,decision:"REJECT",reason:"UNKNOWN_FIELD_OR_SKU_TIER"};if(["TRAFFIC_AWARE","TRAFFIC_AWARE_OPTIMAL"].includes(request.routingPreference))return{skuId:"COMPUTE_ROUTES_PRO",decision:"ALLOW_SYNTHETIC_CONTRACT",reason:"TRAFFIC_FEATURE_SELECTS_PRO"};return{skuId:"COMPUTE_ROUTES_ESSENTIALS",decision:"ALLOW_SYNTHETIC_CONTRACT",reason:"ESSENTIALS_FIELDS_ONLY"}}
  if(request.operation==="MATRIX"){if(request.fieldMask?.some((x)=>!allowedMatrix.has(x))||!["TRAFFIC_UNAWARE","TRAFFIC_AWARE","TRAFFIC_AWARE_OPTIMAL"].includes(request.routingPreference))return{skuId:null,decision:"REJECT",reason:"UNKNOWN_FIELD_OR_SKU_TIER"};if(["TRAFFIC_AWARE","TRAFFIC_AWARE_OPTIMAL"].includes(request.routingPreference))return{skuId:"COMPUTE_MATRIX_PRO",decision:"ALLOW_SYNTHETIC_CONTRACT",reason:"TRAFFIC_FEATURE_SELECTS_PRO"};return{skuId:"COMPUTE_MATRIX_ESSENTIALS",decision:"ALLOW_SYNTHETIC_CONTRACT",reason:"ESSENTIALS_FIELDS_ONLY"}}
  return{skuId:null,decision:"REJECT",reason:"SKU_CLASSIFICATION_UNSUPPORTED"};
}

export function accountAutocomplete({requests,terminatedWithDetailsEssentials}){
  if(!Number.isInteger(requests)||requests<0)fail("autocomplete.requests","must be a non-negative integer");
  if(!terminatedWithDetailsEssentials)return{autocompleteRequestUnits:requests,sessionUsageUnits:0,detailsUnits:0,reason:"ABANDONED_ALL_REQUESTS_BILLABLE"};
  return{autocompleteRequestUnits:Math.min(requests,12),sessionUsageUnits:Math.max(0,requests-12),detailsUnits:1,reason:requests>12?"SUCCESS_AFTER_TWELVE":"SUCCESS_WITHIN_FIRST_TWELVE"};
}

export function accountMatrix({origins,destinations}){if(!Number.isInteger(origins)||!Number.isInteger(destinations)||origins<1||destinations<1)fail("matrix","positive origin and destination counts required");return{billableUnits:origins*destinations,unit:"MATRIX_ELEMENT",reason:"ORIGINS_TIMES_DESTINATIONS"}}
export function accountOptimization({vehicles,shipments}){if(!(vehicles>0&&shipments>=0))fail("optimization","vehicle and shipment counts invalid");return{skuId:vehicles===1?"OPTIMIZATION_SINGLE_VEHICLE":"OPTIMIZATION_FLEET",billableUnits:shipments,unit:"SHIPMENT",reason:vehicles===1?"ONE_VEHICLE_SINGLE_SKU":"TWO_OR_MORE_VEHICLES_FLEET_SKU"}}
export function accountMapLoads({mapInitializations,markerUpdates}){if(!(mapInitializations>=0&&markerUpdates>=0))fail("mapLoads","counts must be non-negative");return{billableUnits:mapInitializations,unit:"MAP_LOAD",reason:"MARKER_UPDATES_DO_NOT_RELOAD_BASE_MAP"}}

export function evaluateCache({obtainedAt,evaluationAt,maxAgeDays}){const age=new Date(evaluationAt)-new Date(obtainedAt);if(!(age>=0&&maxAgeDays>0))fail("cache","invalid time or max age");if(age>maxAgeDays*86400000)return{decision:"REJECT",reason:"PROVIDER_CONTENT_EXPIRED",deleteCustomerAddress:false,deleteKavaRoutesEvidence:false};return{decision:"ALLOW",reason:"PROVIDER_CONTENT_CURRENT",deleteCustomerAddress:false,deleteKavaRoutesEvidence:false}}
export function evaluateDisplay(input){if(input.content==="GOOGLE_CONTENT"&&input.surface==="NON_GOOGLE_MAP")return{decision:"REJECT",reason:"CONTENT_MAP_MISMATCH"};if(input.content==="GOOGLE_CONTENT"&&!input.attributionRendered)return{decision:"REJECT",reason:"ATTRIBUTION_REQUIRED"};return{decision:"ALLOW",reason:input.surface==="GOOGLE_MAP"?"VALID_GOOGLE_MAP_PAIRING":"VALID_ATTRIBUTED_NO_MAP_PAIRING"}}
export function validateTelemetry(fields,manifests){const unsafe=fields.filter((x)=>!manifests.safeTelemetryFields.includes(x));return unsafe.length?{decision:"REJECT",reason:"UNSAFE_TELEMETRY_FIELD",unsafeFieldIds:unsafe.sort(),providerCallMade:false}:{decision:"ALLOW",reason:"SAFE_TELEMETRY_ALLOWLIST"}}

export function admitRequest(input,admission,pricing){
  const operation=admission.operations.find((x)=>x.id===input.operation);if(!operation)return{decision:"REJECT",reason:"UNKNOWN_OPERATION"};
  if(!pricing.skus.some((x)=>x.id===input.skuId))return{decision:"REJECT",reason:"UNKNOWN_SKU"};
  if(!operation.allowedSkus.includes(input.skuId))return{decision:"REJECT",reason:"SKU_NOT_ALLOWED_FOR_OPERATION"};
  if(!input.tenantId?.startsWith("syn_tenant_"))return{decision:"REJECT",reason:"TENANT_SCOPE_REQUIRED"};
  if(input.ledgerTenantId&&input.ledgerTenantId!==input.tenantId)return{decision:"REJECT",reason:"CROSS_TENANT_LEDGER_REFERENCE"};
  if(!(input.estimatedUnits>0))return{decision:"REJECT",reason:"BILLABLE_UNITS_REQUIRED"};
  if(input.tenantUsedUnits+input.estimatedUnits>operation.tenantMonthlyUnitCeiling)return{decision:"REJECT",reason:"TENANT_MONTHLY_UNIT_CEILING_EXCEEDED"};
  if((input.projectDailyUsedUnits??0)+input.estimatedUnits>operation.projectDailyQuotaCeiling)return{decision:"REJECT",reason:"PROJECT_DAILY_QUOTA_CEILING_EXCEEDED"};
  return{decision:"ADMIT_SYNTHETIC_CONTRACT",reason:"HARD_ADMISSION_LIMITS_PASSED"};
}

export function providerAuthority(){return{decision:"REJECT",reason:"PROVIDER_OUTPUT_NOT_DOMAIN_AUTHORITY",authoritativeStateChanged:false}}
export function manualFallback(input){if(input.failure==="MATRIX_UNAVAILABLE_OR_OVER_BUDGET"&&input.hardConstraintsPassed)return{decision:"MANUAL_ACTION_ELIGIBLE",reason:"PRIOR_ASSIGNMENT_PRESERVED_AND_HARD_RULES_PASSED",authoritativeStateChanged:false};return{decision:"REJECT",reason:"HARD_CONSTRAINT_VALIDATION_REQUIRED",authoritativeStateChanged:false}}

export function validateStorage(storage,sources){
  object(storage,"storage");array(storage.records,"storage.records");unique(storage.records,"id","storage.records");
  const sourceIds=new Set(sources.sources.map((x)=>x.id));if(storage.sourceIds.some((id)=>!sourceIds.has(id)))fail("storage.sourceIds","unknown source");
  const cache=storage.records.find((x)=>x.id==="LICENSED_PROVIDER_CACHE"),place=storage.records.find((x)=>x.id==="PROVIDER_REFERENCE");if(cache.maxAge?.value!==30||cache.maxAge?.unit!=="day")fail("storage.LICENSED_PROVIDER_CACHE","30-day default required");if(place.retention!=="PLACE_ID_INDEFINITE"||place.refreshAfter?.value!==12)fail("storage.PROVIDER_REFERENCE","indefinite Place ID with 12-month refresh required");
  for(const rule of ["PROVIDER_OUTPUT_CANNOT_TRANSITION_EXECUTION","PROVIDER_OUTPUT_CANNOT_ESTABLISH_BILLABLE_MILEAGE","OPTIMIZER_OUTPUT_IS_ADVISORY_AND_REQUIRES_KAVAROUTES_COMMAND"])if(!storage.authorityRules.includes(rule))fail("storage.authorityRules",`missing ${rule}`);
  return storage;
}

export function validateCredentials(registry){object(registry,"credentials");if(registry.credentialValuesPresent!==false)fail("credentials.credentialValuesPresent","secret values are forbidden");array(registry.credentialClasses,"credentials.credentialClasses");unique(registry.credentialClasses,"id","credentials.credentialClasses");for(const item of registry.credentialClasses){if(item.rotationState!=="NOT_PROVISIONED"||item.humanApprovalState!=="REQUIRED")fail(`credentials.${item.id}`,"must remain unprovisioned and human-gated");if(/AIza|sk-|secret|password/i.test(item.value??""))fail(`credentials.${item.id}`,"credential value forbidden")}return registry}
export function validateAdmission(registry,pricing){object(registry,"admission");if(registry.budgetAlertsAreHardCaps!==false||registry.admissionControlIsHardCap!==true)fail("admission","alerts and hard caps must remain distinct");array(registry.operations,"admission.operations");unique(registry.operations,"id","admission.operations");const skus=new Set(pricing.skus.map((x)=>x.id));for(const item of registry.operations){if(!item.allowedSkus.length||item.allowedSkus.some((id)=>!skus.has(id)))fail(`admission.${item.id}.allowedSkus`,`unknown SKU`);if(!(item.tenantMonthlyUnitCeiling>0&&item.projectDailyQuotaCeiling>0&&item.tokenBucket.capacity>0&&item.retry.maxAttempts>=0))fail(`admission.${item.id}`,"explicit ceilings, token bucket, and retry limit required")}return registry}

const DEGRADATION_REASONS={ADDRESS_SERVICE_UNAVAILABLE:"ADDRESS_UNVERIFIED_PROVIDER_UNAVAILABLE",ROUTE_UNAVAILABLE:"ROUTE_PROJECTION_UNAVAILABLE",MATRIX_UNAVAILABLE_OR_OVER_BUDGET:"AUTOMATIC_SCORING_STOPPED",OPTIMIZER_UNAVAILABLE_OR_INFEASIBLE:"OPTIMIZATION_PLAN_NOT_APPLIED",DYNAMIC_MAP_UNAVAILABLE:"MAP_ENHANCEMENT_UNAVAILABLE",RATE_LIMIT_OR_QUOTA:"BOUNDED_RETRY_AND_SHEDDING",PRIVACY_POLICY_REJECTION:"MAPS_PRIVACY_FIELD_REJECTED",CREDENTIAL_ABUSE_OR_UNKNOWN_SKU:"PROVIDER_PATH_DISABLED"};
export function validateDegradation(registry){object(registry,"degradation");array(registry.scenarios,"degradation.scenarios");unique(registry.scenarios,"id","degradation.scenarios");exact(registry.scenarios.map((x)=>x.failure),REQUIRED_DEGRADATIONS,"degradation.failures");for(const item of registry.scenarios){if(item.expectedReason!==DEGRADATION_REASONS[item.failure])fail(`degradation.${item.id}`,"unexpected safe reason");if(!["UNCHANGED","PRIOR_ASSIGNMENT_PRESERVED","BOARD_LIST_COMMANDS_REMAIN_AVAILABLE"].includes(item.authoritativeState))fail(`degradation.${item.id}.authoritativeState`,"provider failure cannot mutate authority")}return registry}

export function evaluateGolden(example,context){
  switch(example.type){
    case"AUTOCOMPLETE_ACCOUNTING":return accountAutocomplete(example.input);
    case"MATRIX_ACCOUNTING":return accountMatrix(example.input);
    case"OPTIMIZATION_ACCOUNTING":return accountOptimization(example.input);
    case"FIELD_TIER":return classifySku(example.input);
    case"CACHE_EXPIRY":return evaluateCache(example.input);
    case"DISPLAY_PAIRING":return evaluateDisplay(example.input);
    case"REQUEST_PRIVACY":return{decision:"REJECT",reason:"MAPS_PRIVACY_FIELD_REJECTED",providerCallMade:false};
    case"SAFE_TELEMETRY":{const r=validateTelemetry(example.input.fields,context.manifests);return{decision:r.decision,reason:r.reason,providerCallMade:false}}
    case"COST_ADMISSION":return admitRequest(example.input,context.admission,context.pricing);
    case"MANUAL_FALLBACK":return manualFallback(example.input);
    case"MAP_LOAD_ACCOUNTING":return accountMapLoads(example.input);
    case"AUTHORITY":return providerAuthority();
    default:return{decision:"REJECT",reason:"UNKNOWN_GOLDEN_TYPE"};
  }
}

export function validateGolden(registry,context){object(registry,"golden");array(registry.examples,"golden.examples");unique(registry.examples,"id","golden.examples");for(const type of REQUIRED_GOLDEN_TYPES)if(!registry.examples.some((x)=>x.type===type))fail("golden.examples",`missing ${type}`);for(const item of registry.examples){const actual=evaluateGolden(item,context);if(canonicalJson(actual)!==canonicalJson(item.expected))fail(`golden.${item.id}`,`expected ${canonicalJson(item.expected).trim()}, got ${canonicalJson(actual).trim()}`)}return registry}

export function validateBundle(bundle){validateSources(bundle.sources);validatePricing(bundle.pricing,bundle.sources);validateCapabilities(bundle.capabilities,bundle.pricing,bundle.sources);validateManifests(bundle.manifests,bundle.pricing);validateStorage(bundle.storage,bundle.sources);validateCredentials(bundle.credentials);validateAdmission(bundle.admission,bundle.pricing);validateDegradation(bundle.degradation);validateGolden(bundle.golden,bundle);return bundle}

export function normalizeBundle(bundle,profiles){validateBundle(bundle);const controlled=profiles.map((profile)=>calculateProfileCost(profile,bundle.costModel,bundle.pricing));validateControlledTotals(controlled,bundle.costModel);const sensitivities=bundle.costModel.sensitivityScenarios.map((scenario)=>({id:scenario.id,profiles:profiles.map((profile)=>calculateProfileCost(profile,bundle.costModel,bundle.pricing,scenario.overrides))}));const normalized={contractType:"kavaroutes.synthetic-maps-policy-cost",schemaVersion:"1.0.0",synthetic:true,effectiveDate:bundle.pricing.effectiveDate,priceVersion:bundle.pricing.priceVersion,providerApiCallsMade:0,credentialValuesPresent:false,...bundle,workloadProfiles:profiles.map((profile)=>({id:profile.id,seed:profile.seed,approval:profile.approval,dimensions:profile.dimensions})),controlledCosts:controlled,sensitivities,limitations:["DATED_PRICES_RECHECK_REQUIRED","NO_GOOGLE_APPROVAL","NO_LEGAL_OR_HIPAA_SUITABILITY_CLAIM","NO_ACCURACY_LATENCY_AVAILABILITY_PROOF","NO_PRODUCTION_READINESS","NO_PROVIDER_API_CALL_OR_CREDENTIAL"]};return{...normalized,digest:digest(normalized)}}
