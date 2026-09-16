import {it,expect,vi} from 'vitest';
import {createCloudFacilityApi,decodeFacilityTrip} from '../src/cloud-facility-api';
const id='11111111-1111-4111-8111-111111111111',facility='30000000-0000-4000-8000-000000000002';
const trip={relatedTripReference:id,lifecycle:'COMPLETED',scheduledAt:'2026-09-14T15:00:00Z'};
it('uses facility-only requests and rejects extra sensitive fields or another facility projection',async()=>{
 let body:any={facilityReference:facility,serviceDate:'2026-09-14',items:[trip],nextAfter:null};
 const fetcher=vi.fn(async()=>({status:200,headers:{get:()=>null},json:async()=>body}));
 const api=createCloudFacilityApi('http://127.0.0.1:4311',fetcher);
 expect((await api.day('2026-09-14',null)).value.items).toEqual([trip]);
 expect(fetcher.mock.calls[0]?.[0]).toContain('/facility/days/2026-09-14');
 expect((fetcher.mock.calls[0] as any)[1].headers.authorization).toBe('Synthetic principal_facility');
 body={...body,facilityReference:'22222222-2222-4222-8222-222222222222'};await expect(api.day('2026-09-14',null)).rejects.toMatchObject({code:'INVALID_API_RESPONSE'});
 expect(()=>decodeFacilityTrip({...trip,driverId:id})).toThrow('INVALID_FACILITY_RESPONSE');
 expect(()=>decodeFacilityTrip({...trip,latitude:1})).toThrow('INVALID_FACILITY_RESPONSE');
 expect(()=>decodeFacilityTrip({...trip,lifecycle:'PAID'})).toThrow('INVALID_FACILITY_RESPONSE');
});
