export type BoardStatus = "SCHEDULED" | "READY" | "IN_PROGRESS" | "LATE" | "COMPLETED";
export type ConnectionState = "LIVE" | "STALE" | "DISCONNECTED" | "REPLAYING" | "RESET_REQUIRED" | "ERROR";
export type CommandState = "IDLE" | "SUBMITTING" | "ACCEPTED_AWAITING_PROJECTION" | "CONFLICT" | "REJECTED" | "UNKNOWN" | "RECOVERY_REQUIRED" | "CONFIRMED";

export interface BoardTrip {
  readonly reference: string;
  readonly riderLabel: string;
  readonly pickupLabel: string;
  readonly dropoffLabel: string;
  readonly scheduledTime: string;
  readonly status: BoardStatus;
  readonly driverLabel: string | null;
  readonly vehicleLabel: string | null;
  readonly facilityReference: string;
  readonly version: number;
}

export interface VehiclePosition {
  readonly vehicleReference: string;
  readonly displayLabel: string;
  readonly x: number;
  readonly y: number;
  readonly stale: boolean;
  readonly version: number;
}

export interface BoardProjection {
  readonly organizationReference: string;
  readonly serviceDate: string;
  readonly version: number;
  readonly connection: ConnectionState;
  readonly trips: readonly BoardTrip[];
  readonly positions: readonly VehiclePosition[];
}

export interface AssignmentRequest {
  readonly tripReference: string;
  readonly driverLabel: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface AssignmentReceipt {
  readonly outcome: "ACCEPTED" | "REPLAYED";
  readonly tripReference: string;
  readonly nextVersion: number;
}
