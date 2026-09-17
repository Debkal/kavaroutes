import {useId} from "react";
import {businessToday, businessTimezoneLabel, serviceDayLabel, shiftServiceDay} from "../business-time";

export function ServiceDatePicker({value,onChange,disabled=false,label="Service date"}:{value:string;onChange:(value:string)=>void;disabled?:boolean;label?:string}) {
  const id=useId();
  const today=businessToday();
  return <fieldset className="service-date-picker" disabled={disabled}>
    <legend>{label}</legend>
    <span className="date-caption" aria-hidden="true">{serviceDayLabel(value)}</span>
    <div className="date-navigation">
      <button type="button" aria-label="Previous day" onClick={()=>onChange(shiftServiceDay(value,-1))}>←</button>
      <label className="date-field" htmlFor={id}><span className="sr-status">Choose {label.toLowerCase()}</span>
        <input id={id} aria-label={label} type="date" value={value} onChange={event=>{const next=event.target.value;if(/^\d{4}-\d{2}-\d{2}$/.test(next)&&Number.isFinite(Date.parse(next)))onChange(next);}}/>
      </label>
      <button type="button" aria-label="Next day" onClick={()=>onChange(shiftServiceDay(value,1))}>→</button>
    </div>
    <div className="date-shortcuts">
      <button type="button" aria-pressed={value===today} onClick={()=>onChange(today)}>Today</button>
      <button type="button" aria-pressed={value===shiftServiceDay(today,1)} onClick={()=>onChange(shiftServiceDay(today,1))}>Tomorrow</button>
      <span>Business time · {businessTimezoneLabel}</span>
    </div>
  </fieldset>;
}
