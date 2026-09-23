import {useEffect,useState} from 'react';

/** Editable numeric text without spinner controls or accidental wheel changes. */
export function CostNumberInput({value,onChange,decimal=false,disabled=false,descriptionId}:{value:number;onChange:(value:number)=>void;decimal?:boolean;disabled?:boolean;descriptionId?:string}) {
 const [draft,setDraft]=useState(Number.isFinite(value)?String(value):'');
 const [focused,setFocused]=useState(false);
 useEffect(()=>{if(!focused)setDraft(Number.isFinite(value)?String(value):'');},[value,focused]);
 return <input type="text" disabled={disabled} inputMode={decimal?'decimal':'numeric'}
  pattern={decimal?'[0-9]+([.][0-9]+)?':'[0-9]+'} required
  value={draft} aria-invalid={!Number.isFinite(value)} aria-describedby={descriptionId}
  onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
  onChange={event=>{
   const next=event.target.value;
   if(!(decimal?/^\d*(?:\.\d*)?$/:/^\d*$/).test(next))return;
   setDraft(next);
   onChange(next===''||next==='.'?Number.NaN:Number(next));
  }}/>
}
