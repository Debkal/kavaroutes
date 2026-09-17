import {expect,it,vi} from "vitest";
import {createCloudClientApi,decodeClientRecord,decodeClientRoster} from "../src/cloud-client-api";

const clientId="8aac6384-8c64-4e27-b0ed-44ae2861983d",tripId="4db22a46-b8a3-4a97-94c9-7257740d2b51";
const record={clientId,displayName:"Synthetic Sunrise Residence",entityName:"Sunrise Care Group",phone:"555-0100",
 pickupAddress:"100 Synthetic Sunrise Way",dropoffAddresses:[{ordinal:1,addressLabel:"Synthetic Public Library"},{ordinal:2,addressLabel:"Synthetic Day Program"}],
 tripType:"ROUND_TRIP",notes:"Roleplay client",version:1,routes:[{tripId,serviceDate:"2026-09-17"}]};

it("decodes a client trip pattern and refuses a response that carries extra fields",()=>{
 expect(decodeClientRoster({clients:[record],nextAfter:null}).clients).toEqual([record]);
 expect(()=>decodeClientRecord({...record,driverId:tripId})).toThrow("INVALID_CLIENT_RESPONSE");
 expect(()=>decodeClientRecord({...record,tripType:"ROUNDABOUT"})).toThrow("INVALID_CLIENT_RESPONSE");
 expect(()=>decodeClientRecord({...record,dropoffAddresses:[{ordinal:1,label:"x"}]})).toThrow("INVALID_CLIENT_RESPONSE");
 expect(()=>decodeClientRecord({...record,dropoffAddresses:[{ordinal:0,addressLabel:"x"}]})).toThrow("INVALID_CLIENT_RESPONSE");
 expect(()=>decodeClientRoster({clients:[record]})).toThrow("INVALID_CLIENT_RESPONSE");
});

it("posts the trip pattern with the dispatcher persona, one key and no empty optionals",async()=>{
 const fetcher=vi.fn(async()=>({status:201,headers:{get:()=>null},json:async()=>({clientId,version:1,displayName:"Synthetic Sunrise Residence",dropoffCount:2})}));
 const api=createCloudClientApi("http://127.0.0.1:4311",fetcher);
 const receipt=await api.create({displayName:"Synthetic Sunrise Residence",phone:"555-0100",pickupAddress:"100 Synthetic Sunrise Way",
   dropoffAddresses:["Synthetic Public Library","Synthetic Day Program"],tripType:"ROUND_TRIP",entityName:undefined,notes:null},"web-client-00000000-0000-4000-8000-000000000000");
 expect(receipt.value).toEqual({clientId,version:1,displayName:"Synthetic Sunrise Residence",dropoffCount:2});
 const call=fetcher.mock.calls[0] as unknown as [string,{headers:Record<string,string>;body:string}];
 expect(call[0]).toContain("/clients/commands/create");
 expect(call[1].headers.authorization).toBe("Synthetic principal_dispatcher");
 expect(call[1].headers["idempotency-key"]).toBe("web-client-00000000-0000-4000-8000-000000000000");
 expect(JSON.parse(call[1].body)).toEqual({displayName:"Synthetic Sunrise Residence",phone:"555-0100",pickupAddress:"100 Synthetic Sunrise Way",
   dropoffAddresses:["Synthetic Public Library","Synthetic Day Program"],tripType:"ROUND_TRIP"});
});

it("treats an undecodable receipt as an unknown outcome rather than an accepted client",async()=>{
 const fetcher=vi.fn(async()=>({status:201,headers:{get:()=>null},json:async()=>({clientId,version:1,displayName:"Synthetic Sunrise Residence",dropoffCount:1,unexpected:true})}));
 const api=createCloudClientApi("http://127.0.0.1:4311",fetcher);
 await expect(api.create({displayName:"Synthetic Sunrise Residence",dropoffAddresses:["Synthetic Public Library"]},"web-client-00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});
});

it("still reads a legacy home-only roster and receipt instead of failing",async()=>{
 const fetcher=vi.fn(async(_url:string,init:any)=>({status:init.method==="POST"?201:200,headers:{get:()=>null},json:async()=>init.method==="POST"
  ?{clientId,version:1,displayName:"Synthetic Alex"}
  :{clients:[{clientId,version:1,displayName:"Synthetic Alex",entityName:null,phone:null,addressLabel:"100 Synthetic Home Street",notes:null,routes:[]}],nextAfter:null}}));
 const api=createCloudClientApi("http://127.0.0.1:4311",fetcher);
 const receipt=await api.create({displayName:"Synthetic Alex",pickupAddress:"100 Synthetic Home Street"},"web-client-legacy-test-001");
 expect(receipt.value.dropoffCount).toBe(0);
 expect((await api.roster()).value.clients[0]).toMatchObject({pickupAddress:"100 Synthetic Home Street",dropoffAddresses:[],tripType:null});
});
it("corrects a client with the dispatcher persona and appends drop-offs",async()=>{
 const fetcher=vi.fn(async()=>({status:200,headers:{get:()=>null},json:async()=>({clientId,version:2,displayName:"Synthetic Sunrise Residence",dropoffCount:1})}));
 const api=createCloudClientApi("http://127.0.0.1:4311",fetcher);
 const receipt=await api.update(clientId,{displayName:"Synthetic Sunrise Residence",entityName:"Sunrise Care Group",
   pickupAddress:"100 Synthetic Sunrise Way",tripType:"ROUND_TRIP",notes:"corrected",addDropoffAddresses:["Synthetic Clinic North"]},
   "web-client-update-00000000-0000-4000-8000-000000000000");
 expect(receipt.value).toEqual({clientId,version:2,displayName:"Synthetic Sunrise Residence",dropoffCount:1});
 const call=fetcher.mock.calls[0] as unknown as [string,{headers:Record<string,string>;body:string}];
 expect(call[0]).toContain(`/clients/${clientId}/commands/update`);
 expect(call[1].headers.authorization).toBe("Synthetic principal_dispatcher");
 expect(JSON.parse(call[1].body)).toEqual({displayName:"Synthetic Sunrise Residence",entityName:"Sunrise Care Group",
   pickupAddress:"100 Synthetic Sunrise Way",notes:"corrected",tripType:"ROUND_TRIP",addDropoffAddresses:["Synthetic Clinic North"]});
});
