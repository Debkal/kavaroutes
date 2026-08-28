import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

function percentile(values: readonly number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

test("records bounded browser resource and interaction evidence", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __wp011LongTasks: number[] }).__wp011LongTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) (window as unknown as { __wp011LongTasks: number[] }).__wp011LongTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
  });
  const coldStarted = performance.now();
  await page.goto("/dispatch");
  await expect(page.getByRole("table")).toBeVisible();
  const coldRouteLoadMilliseconds = performance.now() - coldStarted;
  const filterSamples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    await page.getByRole("combobox", { name: "Status", exact: true }).selectOption(index % 2 === 0 ? "LATE" : "ALL");
    await expect(page.getByText(index % 2 === 0 ? "100 shown" : "500 shown")).toBeVisible();
    filterSamples.push(performance.now() - started);
  }
  const selectStarted = performance.now();
  await page.getByRole("button", { name: /Open Rider 0002/ }).click();
  await expect(page.getByRole("heading", { name: "Rider 0002" })).toBeVisible();
  const selectMilliseconds = performance.now() - selectStarted;
  const warmStarted = performance.now();
  await page.reload(); await expect(page.getByRole("table")).toBeVisible();
  const warmRouteLoadMilliseconds = performance.now() - warmStarted;
  const browser = await page.evaluate(() => ({
    domElements: document.querySelectorAll("*").length,
    renderedRows: document.querySelectorAll("tbody tr").length,
    renderedMarkers: document.querySelectorAll(".marker").length,
    longTasks: (window as unknown as { __wp011LongTasks: number[] }).__wp011LongTasks,
    heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  const assetDirectory = path.resolve("dist/assets");
  const assets = await Promise.all((await readdir(assetDirectory)).map(async (name) => ({ name, bytes: (await stat(path.join(assetDirectory, name))).size })));
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), conditions: "Playwright Chromium 151, 1440x900, local loopback, synthetic 500-trip source with 200-row semantic page",
    coldRouteLoadMilliseconds, warmRouteLoadMilliseconds, filterP50Milliseconds: percentile(filterSamples, .5), filterP95Milliseconds: percentile(filterSamples, .95), selectMilliseconds,
    ...browser, longTaskCount: browser.longTasks.length, maximumLongTaskMilliseconds: Math.max(0, ...browser.longTasks), assets,
    finalProjectionDigest: createHash("sha256").update(await page.locator("main").innerText()).digest("hex"),
    limitations: ["Browser resource evidence renders a bounded 200-row semantic page from the 500-trip small profile", "1,500/10,000-trip state transforms are measured separately by workload-report.json", "Local evidence is not production Core Web Vitals or enterprise capacity"],
  };
  await mkdir(path.resolve("artifacts"), { recursive: true });
  await writeFile(path.resolve("artifacts/browser-benchmark-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  expect(report.filterP95Milliseconds).toBeLessThan(200);
  expect(report.horizontalOverflow).toBe(false);
  expect(report.renderedRows).toBeLessThanOrEqual(200);
});
