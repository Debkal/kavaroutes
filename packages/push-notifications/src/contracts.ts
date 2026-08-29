export const PUSH_KINDS = ["sync_available", "review_update", "session_attention"] as const;
export type PushKind = typeof PUSH_KINDS[number];
export type PushAction = "open_and_sync";

export interface PushEnvelope {
  readonly v: "1";
  readonly kind: PushKind;
  readonly action: PushAction;
}

export const GENERIC_VISIBLE_COPY = Object.freeze({
  review_update: Object.freeze({ title: "KavaRoutes update", body: "KavaRoutes has an update. Open the app to review." }),
  session_attention: Object.freeze({ title: "KavaRoutes access", body: "Open KavaRoutes to restore access." }),
});

const prohibitedKey = /(?:^|_)(?:tenant|organi[sz]ation|person|principal|driver|rider|patient|trip|leg|run|facility|vehicle|address|coordinate|latitude|longitude|appointment|mobility|medical|diagnosis|claim|note|count|status|cursor|version|resource|internal|correlation|causation|token|secret|credential|phone|email|name|time|date|location|identifier|id)(?:_|$)/i;
const uuidLike = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const urlLike = /(?:https?:\/\/|[a-z][a-z0-9+.-]*:\/\/)/i;
const coordinateLike = /(?:^|\s)[+-]?(?:[0-8]?\d(?:\.\d+)?|90(?:\.0+)?)[, ]+[+-]?(?:1[0-7]\d(?:\.\d+)?|180(?:\.0+)?|\d?\d(?:\.\d+)?)(?:\s|$)/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePushEnvelope(value: unknown): PushEnvelope {
  if (!record(value)) throw new Error("PUSH_ENVELOPE_INVALID");
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "action" || keys[1] !== "kind" || keys[2] !== "v") throw new Error("PUSH_ENVELOPE_INVALID");
  if (value.v !== "1" || value.action !== "open_and_sync" || !PUSH_KINDS.includes(value.kind as PushKind)) throw new Error("PUSH_ENVELOPE_INVALID");
  return Object.freeze({ v: "1", kind: value.kind as PushKind, action: "open_and_sync" });
}

export function createPushEnvelope(kind: PushKind): PushEnvelope {
  return validatePushEnvelope({ v: "1", kind, action: "open_and_sync" });
}

export function assertNoProhibitedPushData(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error("PUSH_DATA_DEPTH_EXCEEDED");
  if (typeof value === "string") {
    if (uuidLike.test(value) || urlLike.test(value) || coordinateLike.test(value)) throw new Error("PUSH_DATA_POLICY_VIOLATION");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoProhibitedPushData(item, depth + 1);
    return;
  }
  if (!record(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (prohibitedKey.test(key)) throw new Error("PUSH_DATA_POLICY_VIOLATION");
    assertNoProhibitedPushData(nested, depth + 1);
  }
}

export function assertProviderBoundaryEnvelope(value: unknown): PushEnvelope {
  const envelope = validatePushEnvelope(value);
  assertNoProhibitedPushData(envelope);
  return envelope;
}
