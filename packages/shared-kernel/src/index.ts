export type OperationId = string & { readonly __brand: "OperationId" };

export interface RequestContext {
  readonly operationId: OperationId;
  readonly tenantPlaceholder: string;
  readonly actorPlaceholder: string;
  readonly purposePlaceholder: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly policyVersion: "wp005.synthetic.v1";
  readonly schemaVersion: "wp005.synthetic.v1";
}

const safeId = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export function createRequestContext(input: {
  operationId: string;
  tenantPlaceholder: string;
  actorPlaceholder: string;
  purposePlaceholder: string;
  correlationId: string;
  causationId?: string | null;
}): Readonly<RequestContext> {
  for (const value of [input.operationId, input.tenantPlaceholder, input.actorPlaceholder, input.purposePlaceholder, input.correlationId]) {
    if (!safeId.test(value)) throw new Error("UNSAFE_CONTEXT_IDENTIFIER");
  }
  if (input.causationId != null && !safeId.test(input.causationId)) throw new Error("UNSAFE_CONTEXT_IDENTIFIER");
  return Object.freeze({
    operationId: input.operationId as OperationId,
    tenantPlaceholder: input.tenantPlaceholder,
    actorPlaceholder: input.actorPlaceholder,
    purposePlaceholder: input.purposePlaceholder,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    policyVersion: "wp005.synthetic.v1",
    schemaVersion: "wp005.synthetic.v1"
  });
}

export interface Clock { now(): Date; }

export const systemClock: Clock = Object.freeze({ now: () => new Date() });
