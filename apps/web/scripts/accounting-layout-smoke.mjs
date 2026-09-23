import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const css=await readFile(new URL('../src/styles.css',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true});
try {
 for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.setContent('<main class="accounting-page"><details class="workspace-card"><summary>Business insurance — optional</summary><div class="accounting-grid"><div><label class="option-label"><input type="checkbox"><span>Workers’ compensation</span></label><label>Annual premium<input type="text"></label></div></div></details><div class="history-option"><label class="option-label"><input type="checkbox"><span>Use completed trips to refine estimates</span></label></div></main>');
  await page.addStyleTag({content:css});
  assert.equal(await page.locator('details').evaluate(el=>el.open),false);
  await page.locator('summary').click();
  assert.equal(await page.locator('details').evaluate(el=>el.open),true);
  for(const label of await page.locator('.option-label').all()){
   const input=await label.locator('input').boundingBox(),title=await label.locator('span').boundingBox();
   assert.ok(input.width>=18&&input.width<=22);
   assert.ok(Math.abs(input.y+input.height/2-title.y-title.height/2)<2);
   assert.ok(title.x>input.x+input.width);
   await label.click();
   assert.equal(await label.locator('input').isChecked(),true);
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.close();
 }
 console.log('Accounting checkbox alignment and disclosure passed at 390px and 1440px.');
}finally{await browser.close();}
