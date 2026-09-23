import {useState} from 'react';
import {it,expect} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {routeCostProfileDefaults} from '@kavaroutes/api-contracts/route-costing';
import {BusinessInsurance} from '../src/components/BusinessInsurance';
it('makes coverage optional and retains the premium when switched off and back on',()=>{
 function Form(){const [profile,setProfile]=useState(routeCostProfileDefaults);return <BusinessInsurance profile={profile} onChange={setProfile}/>;}
 render(<Form/>);
 const checkbox=screen.getByRole('checkbox',{name:'Workers’ compensation'});
 const input=screen.getByRole('textbox',{name:'Workers’ compensation ($ / year)'});
 expect(checkbox).not.toBeChecked();
 expect(input).toBeDisabled();
 fireEvent.click(checkbox);
 fireEvent.change(input,{target:{value:'6000'}});
 fireEvent.click(checkbox);
 expect(input).toBeDisabled();
 expect(input).toHaveValue('6000');
 fireEvent.click(checkbox);
 expect(input).toBeEnabled();
 expect(input).toHaveValue('6000');
});
