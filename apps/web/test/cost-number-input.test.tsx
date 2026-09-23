import {useState} from 'react';
import {it,expect} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {CostNumberInput} from '../src/components/CostNumberInput';

function Field({decimal=false}:{decimal?:boolean}) {
 const [value,setValue]=useState(12);
 return <><label>Cost<CostNumberInput value={value} onChange={setValue} decimal={decimal}/></label><button disabled={!Number.isFinite(value)}>Save</button></>;
}
it('allows clearing and typing digits without spinners, letters, signs or exponents',()=>{
 render(<Field/>);
 const input=screen.getByRole('textbox',{name:'Cost'});
 expect(input).toHaveAttribute('inputmode','numeric');
 fireEvent.focus(input);
 fireEvent.change(input,{target:{value:''}});
 expect(input).toHaveValue('');
 expect(screen.getByRole('button')).toBeDisabled();
 fireEvent.change(input,{target:{value:'4500'}});
 for(const value of ['abc','1e3','-2','+2','4.5','4 500'])fireEvent.change(input,{target:{value}});
 expect(input).toHaveValue('4500');
 expect(screen.getByRole('button')).toBeEnabled();
});
it('keeps decimal typing intact and offers a decimal phone keyboard',()=>{
 render(<Field decimal/>);
 const input=screen.getByRole('textbox',{name:'Cost'});
 expect(input).toHaveAttribute('inputmode','decimal');
 fireEvent.focus(input);
 fireEvent.change(input,{target:{value:'4.'}});
 expect(input).toHaveValue('4.');
 fireEvent.change(input,{target:{value:'4.25'}});
 fireEvent.change(input,{target:{value:'4.2.5'}});
 expect(input).toHaveValue('4.25');
 fireEvent.blur(input);
 expect(input).toHaveValue('4.25');
});
