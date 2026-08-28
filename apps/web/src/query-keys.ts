export interface QueryContext {
  readonly organizationReference: string;
  readonly principalReference: string;
  readonly purpose: "DISPATCH_CONTROL" | "FACILITY_COORDINATION";
  readonly projection: "DAY_BOARD" | "FACILITY_DAY";
}

function safe(value: string): string {
  if (!/^[a-z0-9-]+$/i.test(value)) throw new Error("UNSAFE_QUERY_CONTEXT");
  return value;
}

export const queryKeys = Object.freeze({
  board(context: QueryContext, serviceDate: string) {
    return ["web", safe(context.organizationReference), safe(context.principalReference), context.purpose, context.projection, "service-date", safe(serviceDate)] as const;
  },
  trip(context: QueryContext, tripReference: string) {
    return ["web", safe(context.organizationReference), safe(context.principalReference), context.purpose, context.projection, "trip", safe(tripReference)] as const;
  },
});
