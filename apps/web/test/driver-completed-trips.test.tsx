import {describe,expect,it} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import type {DriverLeg} from '../src/cloud-driver-api';
import {DriverCompletedTrips,completedDriverLegs,driverLegLifecycle} from '../src/components/DriverCompletedTrips';

const outbound={tripId:'trip',tripLegId:'outbound',riderLabel:'Test rider',pickupLabel:'Home',dropoffLabel:'Clinic',
  runLifecycle:'COMPLETED',execution:{lifecycle:'COMPLETED'}} as DriverLeg;
const returning={...outbound,tripLegId:'return',pickupLabel:'Clinic',dropoffLabel:'Home',execution:{lifecycle:'DISPATCHED'}} as DriverLeg;

describe('individual completed Driver trips',()=>{
  it('lists only the finished leg of a round trip, even when both share a trip and run status',()=>{
    render(<DriverCompletedTrips legs={[outbound,returning]}/>);
    const history=screen.getByLabelText('Completed trips');
    expect(within(history).getAllByRole('listitem',{hidden:true})).toHaveLength(1);
    expect(history).toHaveTextContent('Home → Clinic · Completed');
    expect(history).not.toHaveTextContent('Clinic → Home');
    expect(within(history).getByText('Completed trips (1)')).toBeInTheDocument();
  });
  it('identifies each completed leg separately once the return is actually finished',()=>{
    render(<DriverCompletedTrips legs={[outbound,{...returning,execution:{...returning.execution!,lifecycle:'COMPLETED'}}]}/>);
    const history=screen.getByLabelText('Completed trips');
    expect(within(history).getAllByRole('listitem',{hidden:true})).toHaveLength(2);
    expect(history).toHaveTextContent('Home → Clinic · Completed');
    expect(history).toHaveTextContent('Clinic → Home · Completed');
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
});
