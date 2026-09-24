import type {RoadPreview} from './road-route-contract';

type Step=RoadPreview['steps'][number];
type CompactStep=Step&{key:string|null};

const bareContinue=/^(?:continue(?: straight)?|go straight|proceed straight)[.!]?$/i;
const continuing=(step:Step)=>/^(?:continue|go straight|proceed straight)\b/i.test(step.instruction)
  && !/(?:Left|Right|Merge|Exit|Roundabout|Ferry|Destination|TurnAround)/.test(step.maneuver);

function distance(meters:number){
  const miles=meters/1609.344;
  return miles>=0.1?`${miles.toFixed(1)} mi`:`${Math.max(10,Math.round(meters/0.3048/10)*10)} ft`;
}

export function conciseRoadDirections(steps:readonly Step[]):string[]{
  const compact:CompactStep[]=[];
  for(const step of steps){
    const instruction=step.instruction.trim();
    const key=continuing(step)?(bareContinue.test(instruction)?'continue':instruction.toLowerCase().replace(/[.!]$/,'')):null;
    const previous=compact.at(-1);
    if(key&&previous?.key===key){previous.distanceMeters+=step.distanceMeters;continue;}
    compact.push({...step,instruction,key});
  }
  return compact.map(step=>{
    const instruction=step.instruction.replace(/[.!]$/,'');
    if(step.distanceMeters===0||/^DestinationReached/.test(step.maneuver)||/^(?:arrive|destination|you have reached)\b/i.test(instruction))return `${instruction}.`;
    const duration=distance(step.distanceMeters);
    if(step.key)return `${bareContinue.test(instruction)?'Continue':instruction} for ${duration}.`;
    return `${instruction}. Continue for ${duration}.`;
  });
}
