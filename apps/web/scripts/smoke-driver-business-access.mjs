import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';

const password=process.env.KR_SMOKE_BUSINESS_ACCESS_PASSWORD;
if(!password)throw new Error('KR_SMOKE_BUSINESS_ACCESS_PASSWORD_REQUIRED');
const browser=await chromium.launch({headless:true});
try{
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('https://driver.kavaroutes.com/driver');
  assert.match(page.url(),/\/business-access\?/);
  assert.equal(await page.locator('h1').innerText(),'Business access');
  await page.getByLabel('Business code').fill('test_pony');
  await page.getByLabel('Business access password').fill(password);
  await page.getByRole('button',{name:'Continue to Driver'}).click();
  await page.waitForURL(/\/driver\?businessId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  await page.getByRole('heading',{name:'Driver login'}).waitFor();
  await page.goto('https://driver.kavaroutes.com/driver-admin');
  await page.getByRole('heading',{name:'Driver accounts'}).waitFor();
  process.stdout.write('DRIVER_BUSINESS_ACCESS_BROWSER_SMOKE_PASSED\n');
}finally{await browser.close();}
