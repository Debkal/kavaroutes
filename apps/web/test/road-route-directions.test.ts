import {it,expect} from 'vitest';
import {conciseRoadDirections} from '../src/road-route-directions';

it('collapses repeated straight segments into one distance and keeps turns',()=>{
  const steps=[...Array.from({length:50},()=>({instruction:'Continue',maneuver:'Straight',distanceMeters:100})),
    {instruction:'Turn right onto Main Street',maneuver:'Right',distanceMeters:800},
    {instruction:'Continue on Main Street',maneuver:'Straight',distanceMeters:500},
    {instruction:'Continue on Main Street.',maneuver:'Straight',distanceMeters:500},
    {instruction:'Destination reached',maneuver:'DestinationReached',distanceMeters:0}];
  expect(conciseRoadDirections(steps)).toEqual([
    'Continue for 3.1 mi.',
    'Turn right onto Main Street. Continue for 0.5 mi.',
    'Continue on Main Street for 0.6 mi.',
    'Destination reached.',
  ]);
});

it('does not combine road changes, turns, or short distances',()=>{
  expect(conciseRoadDirections([
    {instruction:'Continue on First Street',maneuver:'Straight',distanceMeters:100},
    {instruction:'Continue on Second Street',maneuver:'Straight',distanceMeters:100},
    {instruction:'Turn left onto Third Street',maneuver:'Left',distanceMeters:60},
    {instruction:'Turn right onto Fourth Street',maneuver:'Right',distanceMeters:0},
  ])).toEqual([
    'Continue on First Street for 330 ft.',
    'Continue on Second Street for 330 ft.',
    'Turn left onto Third Street. Continue for 200 ft.',
    'Turn right onto Fourth Street.',
  ]);
});
