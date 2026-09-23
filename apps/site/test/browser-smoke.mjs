import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const base=process.env.KR_SITE_TEST_URL??'http://127.0.0.1:58110';
const browser=await chromium.launch({headless:true});
await mkdir('/tmp/kavaroutes-site-preview',{recursive:true});
try {
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByRole('heading',{name:'Your NEMT operating system.'}).waitFor();
    assert.equal(await page.getByRole('link',{name:/driver/i}).count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
    await page.screenshot({path:`/tmp/kavaroutes-site-preview/home-${width}.png`,fullPage:true});
    await page.getByRole('link',{name:'Create your business account'}).click();
    await page.getByRole('heading',{name:'Room for your next chapter.'}).waitFor();
    await page.getByRole('status').filter({hasText:'Business sign-in is being prepared'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Continue with Google'}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Continue with Microsoft'}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Create business account'}).isDisabled(),true);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`/tmp/kavaroutes-site-preview/signup-${width}.png`,fullPage:true});
    await page.goto(`${base}/account`);await page.waitForURL('**/sign-in');
    await page.getByRole('link',{name:'Forgot password?'}).click();
    await page.getByRole('heading',{name:'Reset your password.'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Send reset link'}).isDisabled(),true);
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Homepage, mobile layout, accessibility, auth availability, and protected account routes passed.');
}finally{await browser.close();}
