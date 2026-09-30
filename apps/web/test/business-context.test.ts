import {it,expect} from 'vitest';
import {businessContext,setBusinessContext,createBusinessTransport,businessQueryScope} from '../src/business-context';
import {createCloudApi} from '../src/cloud-api';
import {createCloudAccountingApi} from '../src/cloud-accounting-api';
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',principal='10000000-0000-4000-8000-000000000001';
it('business credentials remain in the session and never become a caller-selected persona',async()=>{
 setBusinessContext({organizationId:b,principalId:principal,capabilities:['dispatch:read'],csrf:'c'.repeat(43),mode:'business'});
 const fetcher=async(url:string,init:any)=>{
  expect(url).toContain(`/organizations/${b}/`);expect(init.headers.authorization).toBeUndefined();
  expect(init.headers['x-kr-business-id']).toBe(b);expect(init.headers['x-kr-csrf']).toBe('c'.repeat(43));expect(init.credentials).toBe('same-origin');
  return {status:200,headers:{get:()=>null},json:async()=>({profile:null,version:0})};
 };
 await createCloudAccountingApi('https://app.kavaroutes.com',fetcher).costProfile();
 expect(createCloudApi('https://app.kavaroutes.com',fetcher).organizationId).toBe(b);
 expect(businessQueryScope()).toEqual(['business',b,principal]);
 const transport=createBusinessTransport('https://app.kavaroutes.com',fetcher,b);
 setBusinessContext({organizationId:a,principalId:principal,capabilities:[],csrf:null,mode:'test'});
 await expect(transport.request(`/v1/organizations/${b}/trips`,value=>value)).rejects.toThrow('BUSINESS_SESSION_CHANGED');
});
it('no live factory falls back to a fixed business when signed out',()=>{
 setBusinessContext(null);
 expect(()=>businessContext()).toThrow('BUSINESS_SIGN_IN_REQUIRED');
 expect(()=>createCloudApi('https://app.kavaroutes.com',async()=>({} as any))).toThrow('BUSINESS_SIGN_IN_REQUIRED');
 expect(()=>setBusinessContext({organizationId:a,principalId:principal,capabilities:[],csrf:null,mode:'business'})).toThrow('INVALID_BUSINESS_CONTEXT');
});
