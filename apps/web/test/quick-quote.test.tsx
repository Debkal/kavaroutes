import {it,expect} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {QuickQuote} from '../src/components/QuickQuote';
import {routeCostProfileDefaults} from '@kavaroutes/api-contracts/route-costing';

it('recalculates quotes with waiting and reserves two overhead shares for round trips',()=>{
 const profile={...routeCostProfileDefaults,fuelCentsPerGallon:100,fuelEfficiencyMpg:10,maintenanceCentsPerMile:0,
  driverHourlyCents:6000,driverBurdenPercent:0,insuranceCentsPerMonthPerVehicle:10000,fixedOverheadCentsPerMonth:0,targetMarginPercent:0,deadheadPercent:0};
 render(<QuickQuote profile={profile} tripsPerMonth={100} version={1}/>);
 fireEvent.change(screen.getByLabelText('Loaded miles'),{target:{value:'0'}});
 fireEvent.change(screen.getByLabelText('Paid driving / service minutes'),{target:{value:'0'}});
 expect(screen.getAllByText('$1.00')).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('Journey'),{target:{value:'2'}});
 expect(screen.getAllByText('$2.00')).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('Paid waiting minutes'),{target:{value:'30'}});
 expect(screen.getAllByText('$32.00')).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('Loaded miles'),{target:{value:'-1'}});
 expect(screen.getByRole('button',{name:'Export quote CSV'})).toBeDisabled();
});
