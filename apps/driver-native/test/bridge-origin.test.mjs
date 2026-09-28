import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {driverMessageAllowed,driverOrigin} from '../src/bridge-origin.ts';

test('accepts Android WebView sourceOrigin only when the loaded page is Driver',()=>{
  assert.equal(driverMessageAllowed('https://driver.kavaroutes.com','https://driver.kavaroutes.com/driver'),true);
  assert.equal(driverMessageAllowed('https://driver.kavaroutes.com/','https://driver.kavaroutes.com/driver?businessId=example'),true);
  assert.equal(driverMessageAllowed('https://driver.kavaroutes.com/driver','https://driver.kavaroutes.com/driver'),true);
});

test('rejects messages outside the dedicated top-level Driver page',()=>{
  assert.equal(driverMessageAllowed('https://driver.kavaroutes.com','https://driver.kavaroutes.com/business-access'),false);
  assert.equal(driverMessageAllowed('https://driver.kavaroutes.com',null),false);
  assert.equal(driverMessageAllowed('https://example.com','https://driver.kavaroutes.com/driver'),false);
  assert.equal(driverMessageAllowed('https://driver.kavaroutes.com.evil.test','https://driver.kavaroutes.com/driver'),false);
  assert.equal(driverOrigin('https://driver.kavaroutes.com'),true);
  assert.equal(driverOrigin('https://driver.kavaroutes.com.evil.test'),false);
});
