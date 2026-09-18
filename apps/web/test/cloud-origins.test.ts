import {describe,expect,it,vi} from 'vitest';
import type {DevelopmentFetch} from '@kavaroutes/api-contracts/private-development-transport';
import {createCloudApi} from '../src/cloud-api';
import {createCloudClientApi} from '../src/cloud-client-api';
import {createCloudDriverWebApi} from '../src/cloud-driver-api';
import {createCloudAccountingApi} from '../src/cloud-accounting-api';

/**
 * The local stack is http://127.0.0.1, so a transport that forgets the same-origin HTTPS
 * flag still looks fine in development and then throws PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED
 * on the deployed origin — the shell answers 200 and the router shows "We could not open
 * this view". These cases pin the deployed origin for every web API.
 */
const deployedOrigin = 'https://app.kavaroutes.com';
const fetcher = vi.fn(async () => ({status: 200, headers: {get: () => null}, json: async () => ({})})) as unknown as DevelopmentFetch;

describe('web transports at the deployed origin', () => {
  it('constructs every web API at the HTTPS edge origin', () => {
    const factories = {cloudApi: createCloudApi, clientApi: createCloudClientApi, driverApi: createCloudDriverWebApi,
      accountingApi: createCloudAccountingApi} as const;
    for (const [name, factory] of Object.entries(factories)) expect(() => factory(deployedOrigin, fetcher), name).not.toThrow();
  });

  it('issues the accounting read against the same deployed origin', async () => {
    const calls: string[] = [];
    const recording = (async (url: string) => { calls.push(url); return {status: 200, headers: {get: () => null},
      json: async () => ({profile: null, version: 0}) }; }) as unknown as DevelopmentFetch;
    const api = createCloudAccountingApi(deployedOrigin, recording);
    await api.costProfile();
    expect(calls[0]).toBe(`${deployedOrigin}/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/billing/cost-profile`);
  });

  it('keeps the loopback rule for plain http and refuses a ported https origin', () => {
    // The edge allowance is an assertion the caller (this app, using its own origin) makes:
    // a portless https origin is treated as the edge prototype, while plain http must be
    // loopback and anything with an explicit port is refused outright.
    expect(() => createCloudAccountingApi('http://127.0.0.1:8080', fetcher)).not.toThrow();
    expect(() => createCloudAccountingApi('http://192.168.1.10:8080', fetcher)).toThrow(/PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED/);
    expect(() => createCloudAccountingApi('https://app.kavaroutes.com:8443', fetcher)).toThrow(/PRIVATE_DEVELOPMENT_LOOPBACK_REQUIRED/);
    expect(() => createCloudAccountingApi('https://app.kavaroutes.com/', fetcher)).not.toThrow();
  });
});
