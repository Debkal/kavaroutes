import {describe,expect,it} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import type {DriverLeg} from '../src/cloud-driver-api';
import {DriverCompletedTrips,completedDriverLegs,driverLegLifecycle,groupCompletedDriverTrips} from '../src/components/DriverCompletedTrips';

const outbound={tripId:'trip',tripLegId:'outbound',riderLabel:'Test rider',pickupLabel:'Home',dropoffLabel:'Clinic',
  plannedStartAt:'2026-09-29T15:00:00Z',plannedEndAt:'2026-09-29T16:00:00Z',
  runLifecycle:'COMPLETED',execution:{lifecycle:'COMPLETED'}} as DriverLeg;
const returning={...outbound,tripLegId:'return',pickupLabel:'Clinic',dropoffLabel:'Home',
  plannedStartAt:'2026-09-29T17:00:00Z',plannedEndAt:'2026-09-29T18:00:00Z',execution:{lifecycle:'DISPATCHED'}} as DriverLeg;
const finished=(leg:DriverLeg)=>({...leg,execution:{...leg.execution!,lifecycle:'COMPLETED'}});
const clientA='11111111-1111-4111-8111-111111111111',clientB='22222222-2222-4222-8222-222222222222';

describe('individual completed Driver trips',()=>{
  it('lists only the finished leg of a round trip, even when both share a trip and run status',()=>{
    render(<DriverCompletedTrips legs={[outbound,returning]}/>);
    const history=screen.getByLabelText('Completed trips');
    expect(within(history).getAllByRole('listitem',{hidden:true})).toHaveLength(1);
    expect(history).toHaveTextContent('Home → Clinic · Completed');
    expect(history).not.toHaveTextContent('Clinic → Home');
    expect(within(history).getByText('Completed trips (1)')).toBeInTheDocument();
  });
  it('condenses a completed round trip into one client entry with the whole stop sequence',()=>{
    render(<DriverCompletedTrips legs={[outbound,finished(returning)]}/>);
    const history=screen.getByLabelText('Completed trips');
    expect(within(history).getAllByRole('listitem',{hidden:true})).toHaveLength(1);
    expect(history).toHaveTextContent('Home → Clinic → Home · Completed · 2 legs');
    expect(history).toHaveTextContent('Completed trips (1)');
  });
  it('does not report missing execution, cancellation, or no-show as a completed trip',()=>{
    const pending={...returning,execution:null};
    const cancelled={...returning,execution:{...returning.execution!,lifecycle:'CANCELLED'}};
    const noShow={...returning,execution:{...returning.execution!,lifecycle:'RIDER_NO_SHOW'}};
    expect(driverLegLifecycle(pending)).toBe('AWAITING_DISPATCH');
    expect(completedDriverLegs([outbound,pending,cancelled,noShow])).toEqual([outbound]);
    render(<DriverCompletedTrips legs={[pending,cancelled,noShow]}/>);
    expect(screen.queryByLabelText('Completed trips')).not.toBeInTheDocument();
  });
  it('groups chronological connected bookings for the same client across assignments and appointment waiting',()=>{
    const first={...outbound,riderReference:clientA,assignmentId:'first'};
    const second={...finished(returning),riderReference:clientA,tripId:'second-booking',assignmentId:'second',dropoffLabel:'Lab'};
    const third={...finished(returning),riderReference:clientA,tripId:'third-booking',tripLegId:'third',pickupLabel:'Lab',
      plannedStartAt:'2026-09-29T19:00:00Z',plannedEndAt:'2026-09-29T20:00:00Z'};
    render(<DriverCompletedTrips legs={[third,second,first]}/>);
    const history=screen.getByLabelText('Completed trips');
    expect(within(history).getAllByRole('listitem',{hidden:true})).toHaveLength(1);
    expect(history).toHaveTextContent('Home → Clinic → Lab → Home · Completed · 3 legs');
  });
  it('does not merge different clients who have the same name',()=>{
    expect(groupCompletedDriverTrips([{...outbound,riderReference:clientA},{...finished(returning),riderReference:clientB}])).toHaveLength(2);
  });
  it.each(['COMPLETED','DISPATCHED','CANCELLED','RIDER_NO_SHOW'])('starts a new sequence after an intervening %s leg',lifecycle=>{
    const middle={...outbound,tripId:'middle',tripLegId:'middle',riderReference:clientB,
      plannedStartAt:'2026-09-29T16:10:00Z',plannedEndAt:'2026-09-29T16:40:00Z',execution:{...outbound.execution!,lifecycle}};
    const groups=groupCompletedDriverTrips([{...outbound,riderReference:clientA},middle,{...finished(returning),riderReference:clientA}]);
    expect(groups.filter(group=>group.legs[0]!.riderReference===clientA)).toHaveLength(2);
  });
  it('keeps disconnected stops, overlapping bookings and invalid times in separate entries',()=>{
    expect(groupCompletedDriverTrips([outbound,{...finished(returning),pickupLabel:'Unrelated location'}])).toHaveLength(2);
    expect(groupCompletedDriverTrips([outbound,{...finished(returning),plannedStartAt:'2026-09-29T15:30:00Z'}])).toHaveLength(2);
    expect(groupCompletedDriverTrips([outbound,{...finished(returning),plannedStartAt:'invalid'}])).toHaveLength(2);
  });
  it('uses the booking identity for older payloads and never falls back to grouping by client name',()=>{
    expect(groupCompletedDriverTrips([outbound,finished(returning)])).toHaveLength(1);
    expect(groupCompletedDriverTrips([outbound,{...finished(returning),tripId:'different-booking'}])).toHaveLength(2);
  });
});
