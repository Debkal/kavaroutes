import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Explicit opt-in: creates and cancels ONE synthetic trip in retained development.
if (process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD !== '1') throw new Error('EXPLICIT_PRIVATE_CLOUD_VERIFICATION_REQUIRED');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:4311/dispatch');
  await page.getByRole('heading', { name: 'Cloud trip workspace' }).waitFor();
  const create = page.getByRole('button', { name: 'Create synthetic cloud trip' });
  await create.waitFor();
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/trips'));
  await create.click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const { tripId } = await created.json();
  assert.match(tripId, /^[a-f0-9-]{36}$/);
  await page.getByRole('status').filter({ hasText: 'Trip saved in cloud PostgreSQL.' }).waitFor();
  let row = page.getByRole('row').filter({ hasText: tripId });
  for (let pageIndex = 0; await row.count() === 0 && pageIndex < 10; pageIndex++) {
    const next = page.getByRole('button', { name: 'Next page' });
    if (!await next.isEnabled()) break;
    const loaded = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/trips?'));
    await next.click(); await loaded;
    await page.waitForTimeout(100);
    row = page.getByRole('row').filter({ hasText: tripId });
  }
  await row.waitFor();
  page.once('dialog', dialog => dialog.accept());
  const cancelledResponse = page.waitForResponse(response => response.url().endsWith(`/trips/${tripId}/commands/cancel`));
  await row.getByRole('button', { name: 'Cancel trip' }).click();
  const cancelled = await cancelledResponse;
  assert.equal(cancelled.status(), 200);
  assert.equal((await cancelled.json()).trip.lifecycle, 'CANCELLED');
  await page.getByRole('status').filter({ hasText: 'Cancellation confirmed by cloud backend.' }).waitFor();
  // Reload proves this is not only an optimistic/in-memory browser mutation.
  await page.reload();
  await page.getByRole('heading', { name: 'Cloud trip workspace' }).waitFor();
  // Server-authorized read of this exact record avoids first-page ordering assumptions.
  const persisted = await page.request.get(`http://127.0.0.1:4311/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/trips/${tripId}`, {
    headers: { authorization: 'Synthetic principal_dispatcher' },
  });
  assert.equal(persisted.status(), 200);
  assert.equal((await persisted.json()).lifecycle, 'CANCELLED');
  await page.getByRole('link', { name: 'Clients', exact: true }).click();
  await page.getByRole('heading', { name: 'Facility cloud integration pending' }).waitFor();
  assert.equal(await page.getByText('Client arrivals').count(), 0);
  console.log(JSON.stringify({ result: 'CLOUD_WEB_TRIP_FLOW_PASSED', created: true, cancelled: true, persistedAfterReload: true, facilityFixtureFallback: false }));
} finally { await browser.close(); }
