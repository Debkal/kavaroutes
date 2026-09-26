import { describe, expect, it, vi } from "vitest";
import { chooseDriverWork, nextControl } from "../src/routes/cloud-driver-route";
import type { DriverLeg } from "../src/cloud-driver-api";
import type {DriverItinerary,DriverShiftState} from '@kavaroutes/api-contracts/client-web';

/** Regression lock for WEB-A-001/WEB-A-002: the server attests a pickup signature
 * only after the physical controls are recorded, and refuses boarding without the
 * signature when the proof rule requires one. The driver surface must offer exactly
 * that order, so a signature-required leg can reach ONBOARD. */
const leg = (lifecycle: string, control: Partial<NonNullable<NonNullable<DriverLeg["execution"]>["serviceControl"]>> = {}, pickupRequired = true): DriverLeg => ({
  execution: {
    executionId: "33333333-3333-4333-8333-333333333333",
    lifecycle,
    version: 3,
    serviceControl: {
      boardingSecure: false,
      dropoffEvidenceId: null,
      incidentOpen: false,
      pickupEvidenceId: null,
      riderVerified: false,
      safelyUnloaded: false,
      proofRule: {
        digest: "0".repeat(64),
        version: 1,
        rule: {
          allowedRoles: ["RIDER", "GUARDIAN_OR_AUTHORIZED_REPRESENTATIVE", "FACILITY_EMPLOYEE", "DRIVER", "RIDER_UNABLE_TO_SIGN"],
          dropoffRequired: true,
          mobilitySecurementRequired: false,
          noShowAllowed: true,
          noShowAuthorizationReference: null,
          noShowWaitMinutes: 15,
          pickupRequired,
          unableReasons: ["DECLINED", "PHYSICALLY_UNABLE", "NO_AUTHORIZED_SIGNER"],
        },
      },
      ...control,
    },
  },
}) as unknown as DriverLeg;

describe("driver pickup control order", () => {
  it("asks for the physical controls before the required pickup signature", () => {
    expect(nextControl(leg("ARRIVED_PICKUP"))).toMatchObject({ label: "Verify and secure the rider", workflow: "PICKUP_CONTROLS" });
  });

  it("keeps verifying the rider until both controls are recorded", () => {
    expect(nextControl(leg("ARRIVED_PICKUP", { riderVerified: true }))).toMatchObject({ label: "Verify and secure the rider", workflow: "PICKUP_CONTROLS" });
  });

  it("offers the pickup signature only after the rider is verified and secured", () => {
    expect(nextControl(leg("ARRIVED_PICKUP", { riderVerified: true, boardingSecure: true })))
      .toMatchObject({ label: "Collect pickup signature", signature: "PICKUP_ATTESTATION" });
  });

  it("offers boarding once the required signature is recorded, and boards a leg that needs none", () => {
    expect(nextControl(leg("ARRIVED_PICKUP", { riderVerified: true, boardingSecure: true, pickupEvidenceId: "44444444-4444-4444-8444-444444444444" })))
      .toMatchObject({ label: "Board the rider", workflow: "PICKUP_COMPLETE" });
    expect(nextControl(leg("ARRIVED_PICKUP", { riderVerified: true, boardingSecure: true }, false)))
      .toMatchObject({ label: "Board the rider", workflow: "PICKUP_COMPLETE" });
  });

  it("mirrors the order at the drop-off", () => {
    expect(nextControl(leg("ARRIVED_DROPOFF"))).toMatchObject({ label: "Unload the rider", workflow: "DROPOFF_CONTROLS" });
    expect(nextControl(leg("ARRIVED_DROPOFF", { safelyUnloaded: true }))).toMatchObject({ label: "Collect drop-off signature", signature: "DROPOFF_ATTESTATION" });
    expect(nextControl(leg("ARRIVED_DROPOFF", { safelyUnloaded: true, dropoffEvidenceId: "55555555-5555-4555-8555-555555555555" })))
      .toMatchObject({ label: "Finish this trip", workflow: "DROPOFF_COMPLETE" });
  });

  it("offers no control while an incident is open", () => {
    expect(nextControl(leg("ARRIVED_PICKUP", { incidentOpen: true }))).toBeNull();
  });
});

describe('driver sign-in without an unfinished trip',()=>{
  const assignment='11111111-1111-4111-8111-111111111111';
  const manifest=(legs:unknown[])=>({legs}) as unknown as DriverItinerary;
  const item=(lifecycle:string,reference:string)=>({assignmentId:assignment,tripLegId:reference,execution:{lifecycle}});
  it('keeps a valid login open when the date has no assignments',async()=>{
    const read=vi.fn();
    expect(await chooseDriverWork(manifest([]),read)).toEqual({leg:null,shift:null,hasUnfinished:false});
    expect(read).not.toHaveBeenCalled();
  });
  it('resumes return review after every leg is complete',async()=>{
    const completed=item('COMPLETED','completed');
    const active={lifecycle:'ACTIVE'} as DriverShiftState;
    const selected=await chooseDriverWork(manifest([completed]),async()=>active);
    expect(selected).toMatchObject({leg:completed,shift:active,hasUnfinished:false});
  });
  it('starts at the unfinished leg in a mixed assignment',async()=>{
    const unfinished=item('DISPATCHED','unfinished');
    const read=vi.fn(async()=>null);
    const selected=await chooseDriverWork(manifest([item('COMPLETED','completed'),unfinished]),read);
    expect(selected).toMatchObject({leg:unfinished,shift:null,hasUnfinished:true});
    expect(read).toHaveBeenCalledTimes(1);
  });
});
