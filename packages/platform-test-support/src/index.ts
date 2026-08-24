import { createRequestContext } from "@kavaroutes/shared-kernel";

export function syntheticContext() {
  return createRequestContext({
    operationId: "op_synthetic_001",
    tenantPlaceholder: "tenant_synthetic",
    actorPlaceholder: "actor_synthetic",
    purposePlaceholder: "purpose_test",
    correlationId: "corr_synthetic_001"
  });
}

export const forbiddenCanaries = Object.freeze([
  "CANARY_AUTH_SECRET_91",
  "CANARY_COOKIE_SECRET_92",
  "CANARY_BODY_PRIVATE_93",
  "CANARY_QUERY_PRIVATE_94",
  "CANARY_ADDRESS_PRIVATE_95",
  "CANARY_COORDINATE_PRIVATE_96",
  "CANARY_IDENTITY_PRIVATE_97",
  "CANARY_SIGNATURE_PRIVATE_98"
]);
