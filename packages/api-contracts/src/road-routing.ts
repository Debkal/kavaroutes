import { Type, type Static } from 'typebox';

const goal = () => Type.Union([
  Type.Literal('LOW_COST'), Type.Literal('FASTEST'), Type.Literal('EASIEST'),
]);
export const RoadRouteGoalSchema = Type.Union([
  Type.Literal('LOW_COST'), Type.Literal('FASTEST'), Type.Literal('EASIEST'),
], { $id: 'RoadRouteGoal' });
export type RoadRouteGoal = Static<typeof RoadRouteGoalSchema>;

export const RoadRoutePreviewRequestSchema = Type.Object({ goal: goal() },
  { additionalProperties: false, $id: 'RoadRoutePreviewRequest' });
export const RoadRouteSelectRequestSchema = Type.Object({
  goal: goal(), expectedVersion: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false, $id: 'RoadRouteSelectRequest' });

export const RoadRouteSelectionSchema = Type.Object({
  goal: Type.Union([goal(), Type.Null()]),
  version: Type.Integer({ minimum: 0 }),
  selectedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
}, { additionalProperties: false, $id: 'RoadRouteSelection' });
export type RoadRouteSelection = Static<typeof RoadRouteSelectionSchema>;

export const RoadRoutePreviewSchema = Type.Object({
  goal: goal(), provider: Type.Literal('GOOGLE_ROUTES'),
  distanceMeters: Type.Integer({ minimum: 1 }), durationSeconds: Type.Integer({ minimum: 1 }),
  tollEstimate: Type.Union([Type.Null(), Type.Object({ currencyCode: Type.String({ minLength: 3, maxLength: 3 }), amount: Type.Number({ minimum: 0 }) }, { additionalProperties: false })]),
  tollsExpected: Type.Boolean(), maneuverCount: Type.Integer({ minimum: 0 }),
  pathFingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  steps: Type.Array(Type.Object({ instruction: Type.String({ minLength: 1, maxLength: 500 }), maneuver: Type.String({ maxLength: 60 }), distanceMeters: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), { maxItems: 300 }),
  mapImageUrl: Type.Union([Type.String({ pattern: '^https://maps\\.googleapis\\.com/maps/api/staticmap\\?', maxLength: 16384 }), Type.Null()]),
  googleMapsUrl: Type.String({ pattern: '^https://www\\.google\\.com/maps/dir/\\?api=1&', maxLength: 2048 }),
  note: Type.String({ minLength: 1, maxLength: 300 }),
}, { additionalProperties: false, $id: 'RoadRoutePreview' });
export type RoadRoutePreview = Static<typeof RoadRoutePreviewSchema>;

export class RoadRoutingError extends Error {
  constructor(readonly statusCode: 404 | 409 | 412 | 502 | 503, readonly code: string) {
    super(code); this.name = 'RoadRoutingError';
  }
}

export const RoadRouteDriverViewSchema = Type.Object({
  selection: Type.Ref('RoadRouteSelection'),
  route: Type.Union([Type.Ref('RoadRoutePreview'), Type.Null()]),
}, { additionalProperties: false, $id: 'RoadRouteDriverView' });

export interface RoadRoutingService {
  readonly configured: boolean;
  selection(input: { organizationId: string; legId: string; driverId?: string }): Promise<RoadRouteSelection>;
  preview(input: { organizationId: string; legId: string; goal: RoadRouteGoal; includeMap: boolean; driverId?: string }): Promise<RoadRoutePreview>;
  select(input: { organizationId: string; legId: string; actorId: string; goal: RoadRouteGoal; expectedVersion: number; key: string }): Promise<RoadRouteSelection>;
}
