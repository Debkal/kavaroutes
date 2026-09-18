import { Type,type Static } from "typebox";

/**
 * The dispatch view of live driver positioning: where each shift is now, the bounded
 * trace behind it, and how long a lost signal has lasted. Coordinates appear only here,
 * on an authorized dispatch read — never in a log line or a problem body.
 */
const id = () => Type.String({ format: "uuid" });
const closed = { additionalProperties: false } as const;
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);

export const DispatchTrackPointSchema = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracyMeters: nullable(Type.Number({ minimum: 0, maximum: 100000 })),
  capturedAt: Type.String({ format: "date-time", maxLength: 35 }),
}, { ...closed, $id: "DispatchTrackPoint" });
export const DispatchShiftTrackSchema = Type.Object({
  shiftReference: id(),
  driverId: id(),
  driverLabel: Type.String({ minLength: 1, maxLength: 200 }),
  /** The board names a shift by its part of day: the assigned run's planned start, when
   * the driver actually began, and the vehicle on the assignment. */
  plannedStartAt: Type.String({ format: "date-time", maxLength: 35 }),
  startedAt: Type.String({ format: "date-time", maxLength: 35 }),
  vehicleLabel: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  lifecycle: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.String({ minLength: 1, maxLength: 64 }),
  reason: Type.String({ minLength: 1, maxLength: 96 }),
  contactDriver: Type.Boolean(),
  /** Seconds since the last update the server received; zero while updates are current. */
  silentSeconds: Type.Integer({ minimum: 0 }),
  lastReceivedAt: nullable(Type.String({ format: "date-time", maxLength: 35 })),
  lastCapturedAt: nullable(Type.String({ format: "date-time", maxLength: 35 })),
  staleAfterSeconds: Type.Integer({ minimum: 1 }),
  /** How long the driver app waits before trying to reconnect. */
  retryAfterSeconds: Type.Integer({ minimum: 1 }),
  position: Type.Union([Type.Null(), DispatchTrackPointSchema]),
  trace: Type.Array(Type.Ref("DispatchTrackPoint"), { maxItems: 500 }),
}, { ...closed, $id: "DispatchShiftTrack" });
export const DispatchTrackingSchema = Type.Object({
  serviceDate: Type.String({ format: "date", maxLength: 10 }),
  shifts: Type.Array(DispatchShiftTrackSchema, { maxItems: 200 }),
}, { ...closed, $id: "DispatchTracking" });
export type DispatchTracking = Static<typeof DispatchTrackingSchema>;
export type DispatchShiftTrack = Static<typeof DispatchShiftTrackSchema>;
export type DispatchTrackingReader = (organizationId: string, serviceDate: string) => Promise<DispatchTracking>;
