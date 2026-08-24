import { Type, type Static } from "typebox";

export const SafeErrorSchema = Type.Object({
  code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{2,63}$" }),
  operationId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{2,63}$" })
}, { additionalProperties: false, $id: "SafeError" });

export const HealthSchema = Type.Object({
  status: Type.Literal("ok"),
  version: Type.Literal("wp005.synthetic.v1")
}, { additionalProperties: false, $id: "Health" });

export const ReadinessSchema = Type.Object({
  status: Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]),
  checks: Type.Object({ engine: Type.Boolean() }, { additionalProperties: false })
}, { additionalProperties: false, $id: "Readiness" });

export const ProbeRequestSchema = Type.Object({
  probeId: Type.String({ pattern: "^probe_[a-z0-9]{8}$" }),
  input: Type.Union([Type.Literal("alpha"), Type.Literal("bravo")]),
  idempotencyKey: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{2,63}$" })
}, { additionalProperties: false, $id: "ProbeRequest" });

export const ProbeResponseSchema = Type.Object({
  probeId: Type.String(),
  outcome: Type.Literal("accepted"),
  jobId: Type.String(),
  operationId: Type.String()
}, { additionalProperties: false, $id: "ProbeResponse" });

export const SocketNotificationSchema = Type.Object({
  type: Type.Literal("wp005.synthetic.notification"),
  operationId: Type.String(),
  sequence: Type.Literal(1)
}, { additionalProperties: false, $id: "SocketNotification" });

export type ProbeRequest = Static<typeof ProbeRequestSchema>;
export type SocketNotification = Static<typeof SocketNotificationSchema>;
