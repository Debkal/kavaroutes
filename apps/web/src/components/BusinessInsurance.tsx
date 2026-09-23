import type {RouteCostProfile} from '@kavaroutes/api-contracts/route-costing';
import {CostNumberInput} from './CostNumberInput';

const coverages = [["workersCompAnnualCents","Workers’ compensation"],["generalLiabilityAnnualCents","General liability"],["umbrellaAnnualCents","Umbrella / excess liability"],["professionalLiabilityAnnualCents","Professional liability"],["cyberInsuranceAnnualCents","Cyber insurance"],["otherInsuranceAnnualCents","Other business insurance"]] as const;
const descriptions:Record<string,string>={
 workersCompAnnualCents:"Annual premium budget for employee work-related injury coverage.",
 generalLiabilityAnnualCents:"Annual premium for your general business liability policy.",
 umbrellaAnnualCents:"Annual premium for additional liability limits above underlying policies.",
 professionalLiabilityAnnualCents:"Annual premium for your professional services liability policy.",
 cyberInsuranceAnnualCents:"Annual premium for coverage related to data and cybersecurity incidents.",
 otherInsuranceAnnualCents:"Other business premiums not included in the categories above."
};
export function BusinessInsurance({profile,onChange}:{profile:RouteCostProfile;onChange:(profile:RouteCostProfile)=>void}) {
 const selected=profile.includedBusinessInsurance??coverages.filter(([key])=>(profile[key]??0)>0).map(([key])=>key);
 return <div className="accounting-grid">{coverages.map(([key,label])=>{
  const checked=selected.includes(key);
  return <div key={key}>
   <label className="option-label"><input type="checkbox" checked={checked} onChange={event=>onChange({...profile,includedBusinessInsurance:event.target.checked?[...selected,key]:selected.filter(item=>item!==key)})}/><span>{label}</span></label>
   <small className="field-help" id={`insurance-help-${key}`}>{descriptions[key]}</small>
   <label>{label} ($ / year)<CostNumberInput decimal disabled={!checked} descriptionId={`insurance-help-${key}`} value={(profile[key]??0)/100} onChange={value=>onChange({...profile,[key]:Math.round(value*100)})}/></label>
  </div>;
 })}</div>;
}
