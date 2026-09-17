import type { TSchema } from "typebox";
import { coreSchemas } from "./schemas.js";
import { AssignDispatchRunRequestSchema, AssignDispatchRunReceiptSchema, DispatchBoardSchema, DispatchPlanLegSchema, PlanDispatchRunRequestSchema, PlanDispatchRunReceiptSchema, UnassignDispatchRunRequestSchema, UnassignDispatchRunReceiptSchema } from "./dispatch-board.js";
import { ClientCreateReceiptSchema, ClientCreateRequestSchema, ClientRosterSchema, ClientUpdateRequestSchema } from "./client-records.js";
import { DriverLoginClaimRequestSchema, DriverLoginCreateRequestSchema, DriverLoginReceiptSchema, DriverLoginStateSchema, DriverLoginVerifyRequestSchema } from "./driver-logins.js";
import { FacilityDaySchema } from "./facility-day.js";
import { RouteDecisionRequestSchema, RouteProposalReceiptSchema, RouteProposalRequestSchema, RouteProposalViewSchema } from "./route-proposals.js";
import {
  DriverClosureReceiptSchema, DriverClosureRequestSchema, DriverClosureViewSchema, DriverReturnOverrideRequestSchema,
  DriverReturnReviewSchema, DriverSyntheticLocationReceiptSchema, DriverSyntheticLocationRequestSchema,
} from "./driver-closure.js";
import {
  BrowserCommandEnvelopeSchema, BrowserCommandPendingSchema, BrowserCommandPrepareSchema, BrowserCommandViewSchema,
} from "./browser-recovery.js";
import { DriverPrecheckReceiptSchema, DriverPrecheckRequestSchema, DriverShiftStateSchema } from "./driver-precheck.js";
import { StartDriverShiftReceiptSchema, StartDriverShiftRequestSchema } from "./driver-shift.js";
import { DriverSignatureReceiptSchema, DriverSignatureRequestSchema } from "./driver-service-proof.js";

/** Every TypeBox schema this contract defines.
 *
 * One registry, so the OpenAPI document, the generated clients and the
 * contract lint cannot disagree about which schemas exist. Add a schema here
 * (or add its module's exports to this list) rather than calling
 * `app.addSchema` at a second place in the composition. */
export const allSchemas: readonly TSchema[] = Object.freeze([
  /// Registration order is preserved deliberately: @fastify/swagger names the
  /// untitled `$ref` components `def-N` in traversal order, so reordering this
  /// list rewrites those names and produces a spurious contract diff.
  ...coreSchemas,
  DispatchBoardSchema, AssignDispatchRunRequestSchema, AssignDispatchRunReceiptSchema,
  /// A planned run carries its legs inline, so the leg object is registered too.
  DispatchPlanLegSchema, PlanDispatchRunRequestSchema, PlanDispatchRunReceiptSchema, UnassignDispatchRunRequestSchema, UnassignDispatchRunReceiptSchema,
  ClientCreateRequestSchema, ClientCreateReceiptSchema, ClientRosterSchema, ClientUpdateRequestSchema,
  DriverLoginCreateRequestSchema, DriverLoginReceiptSchema, DriverLoginClaimRequestSchema, DriverLoginVerifyRequestSchema, DriverLoginStateSchema,
  StartDriverShiftRequestSchema, StartDriverShiftReceiptSchema,
  DriverPrecheckRequestSchema, DriverPrecheckReceiptSchema, DriverShiftStateSchema,
  DriverSignatureRequestSchema, DriverSignatureReceiptSchema,
  FacilityDaySchema,
  DriverClosureRequestSchema, DriverClosureReceiptSchema, DriverClosureViewSchema,
  DriverSyntheticLocationRequestSchema, DriverSyntheticLocationReceiptSchema,
  DriverReturnOverrideRequestSchema, DriverReturnReviewSchema,
  RouteProposalRequestSchema, RouteDecisionRequestSchema, RouteProposalReceiptSchema, RouteProposalViewSchema,
  BrowserCommandEnvelopeSchema, BrowserCommandPrepareSchema, BrowserCommandViewSchema, BrowserCommandPendingSchema,
]);
