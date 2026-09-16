import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

// One synthetic create/cancel to prove a missed material change reaches the UI.
if (process.env.KAVAROUTES_VERIFY_PRIVATE_CLOUD !== "1") throw Error("EXPLICIT_PRIVATE_CLOUD_VERIFICATION_REQUIRED");
const browser = await chromium.launch();
const base = "http://127.0.0.1:4311/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const headers = { authorization: "Synthetic principal_dispatcher" };
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.socketEvidence = { blocked: false, sockets: [], frames: [], acks: [] };
    window.WebSocket = class extends Native {
      constructor(...args) {
        if (window.socketEvidence.blocked) throw Error("SIMULATED_SOCKET_DISCONNECT");
        super(...args);
        window.socketEvidence.sockets.push(this);
        this.addEventListener("message", event => window.socketEvidence.frames.push(JSON.parse(event.data)));
      }
      send(value) {
        const frame = JSON.parse(value);
        if (frame.type === "subscription.ack") window.socketEvidence.acks.push(frame.cursor);
        super.send(value);
      }
    };
  });
  await page.goto("http://127.0.0.1:4311/dispatch");
  await page.getByText("Cloud updates: live", { exact: true }).waitFor();
  const createdResponse = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/trips"));
  await page.getByRole("button", { name: "Create synthetic cloud trip", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const { tripId } = await created.json();
  let row = page.getByRole("row").filter({ hasText: tripId });
  for (let i = 0; await row.count() === 0 && i < 20; i++) {
    const next = page.getByRole("button", { name: "Next page" });
    if (!await next.isEnabled()) break;
    const response = page.waitForResponse(r => r.url().includes("/trips?"));
    await next.click(); await response;
    await page.waitForTimeout(100);
  }
  await row.waitFor();
  // Block REST polling in this browser until socket replay arrives, so polling
  // cannot make this evidence pass by itself. APIRequestContext remains usable.
  let allowRefresh = false;
  await page.route("**/v1/organizations/**/trips?*", route => allowRefresh ? route.continue() : route.abort());
  await page.evaluate(() => {
    window.socketEvidence.blocked = true;
    window.socketEvidence.frames = [];
    window.socketEvidence.acks = [];
    window.socketEvidence.sockets.at(-1).close();
  });
  const current = await page.request.get(`${base}/trips/${tripId}`, { headers });
  assert.equal(current.status(), 200);
  const cancelled = await page.request.post(`${base}/trips/${tripId}/commands/cancel`, {
    headers: { ...headers, "if-match": current.headers().etag, "idempotency-key": `web-replay-cancel-${randomUUID()}` },
    data: { reasonCode: "SYNTHETIC_REQUESTER_CANCELLED" },
  });
  assert.equal(cancelled.status(), 200);
  assert.equal((await cancelled.json()).trip.lifecycle, "CANCELLED");
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "change.batch" && frame.changes.some(c =>
      c.delta.resourceReference === `trip:${tripId}` && c.delta.resourceVersion === 2)) allowRefresh = true;
  }));
  await page.evaluate(() => { window.socketEvidence.blocked = false; });
  await page.waitForFunction(id => window.socketEvidence.frames.some(f => f.type === "change.batch" &&
    f.changes.some(c => c.delta.resourceReference === `trip:${id}` && c.delta.resourceVersion === 2) &&
    window.socketEvidence.acks.includes(f.cursor)), tripId, { timeout: 30_000 });
  await row.getByRole("cell", { name: "CANCELLED", exact: true }).waitFor();
  assert.equal(allowRefresh, true);
  console.log("CLOUD_WEB_MISSED_CANCELLATION_REPLAYED_AND_RENDERED");
} finally { await browser.close(); }
