import {expect,it} from 'vitest';
import {distanceByWindow,lineMeters,miles} from '../src/route-distance';

it('sums each leg without connecting waiting gaps or other legs',()=>{
  const first:[[number,number],[number,number]]=[[41.88,-87.62],[41.89,-87.62]];
  const second:[[number,number],[number,number]]=[[41.90,-87.62],[41.91,-87.62]];
  const distances=distanceByWindow([{window:1,coords:first},{window:2,coords:second}]);
  expect(distances.size).toBe(2);
  expect(distances.get(1)).toBeCloseTo(lineMeters(first));
  expect(distances.get(2)).toBeCloseTo(lineMeters(second));
  expect(miles(distances.get(1)!)).toBe('0.7 mi');
});
