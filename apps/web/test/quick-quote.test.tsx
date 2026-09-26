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
 fireEvent.change(screen.getByLabelText('Insurance scenario ($/month/vehicle)'),{target:{value:'200'}});
 expect(screen.getAllByText('$34.00')).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('Loaded miles'),{target:{value:'-1'}});
 expect(screen.getByRole('button',{name:'Export quote CSV'})).toBeDisabled();
});

it('separates the customer waiting charge from paid waiting cost',()=>{
 const profile={...routeCostProfileDefaults,fuelCentsPerGallon:100,fuelEfficiencyMpg:10,maintenanceCentsPerMile:0,
  driverHourlyCents:6000,driverBurdenPercent:0,insuranceCentsPerMonthPerVehicle:0,fixedOverheadCentsPerMonth:0,targetMarginPercent:0,deadheadPercent:0};
 render(<QuickQuote profile={profile} tripsPerMonth={100} version={1}/>);
 fireEvent.change(screen.getByLabelText('Loaded miles'),{target:{value:'0'}});
 fireEvent.change(screen.getByLabelText('Paid driving / service minutes'),{target:{value:'0'}});
 fireEvent.change(screen.getByLabelText('Paid waiting minutes'),{target:{value:'55'}});
 fireEvent.change(screen.getByLabelText('Agreed trip charge before waiting ($)'),{target:{value:'340'}});
 fireEvent.change(screen.getByLabelText('Waiting charge per hour ($)'),{target:{value:'65'}});
 fireEvent.change(screen.getByLabelText('Billable waiting minutes'),{target:{value:'60'}});
 expect(screen.getByText('$405.00')).toBeInTheDocument();
 expect(screen.getByText('86.4%')).toBeInTheDocument();
});
