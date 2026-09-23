import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("dispatch stays keyboard-operable and has no automated accessibility violation", async ({ page }) => {
  await page.goto("/dispatch");
  await expect(page.getByRole("heading", { name: "Today’s operations" })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByText("Skip to main content")).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("map-off mode preserves the trip board and command", async ({ page }) => {
  await page.goto("/dispatch");
  await page.getByLabel("Map mode").selectOption("UNAVAILABLE");
  await expect(page.getByText("Map unavailable.")).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("button", { name: "Assign Driver 042" })).toBeVisible();
});

test("client view exposes only its scoped projection", async ({ page }) => {
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Client arrivals" })).toBeVisible();
  await expect(page.getByText("This view does not request fleet positions, driver availability, breadcrumbs, billing, claims, or administration data.")).toBeVisible();
  await expect(page.getByText("Fleet map")).toHaveCount(0);
});

test("narrow dispatch provides safe read and recovery", async ({ page }) => {
  await page.goto("/dispatch");
  await page.getByRole("button", { name: "Simulate disconnect" }).click();
  await expect(page.getByTestId("connection-state")).toContainText("disconnected");
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByTestId("connection-state")).toContainText("live");
});

test("assignment waits for confirmation and then follows the authoritative projection", async ({ page }) => {
  await page.goto("/dispatch");
  await page.getByRole("button", { name: "Assign Driver 042" }).click();
  await expect(page.getByRole("dialog")).toContainText("authoritative projection");
  await page.getByRole("button", { name: "Confirm assignment" }).click();
  await expect(page.getByRole("status").filter({ hasText: "confirmed" })).toBeVisible();
  await expect(page.getByRole("complementary")).toContainText("Driver 042");
});

test("layout reflows without document-level horizontal overflow", async ({ page }) => {
  await page.goto("/dispatch");
  await expect(page.getByRole("table")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Driver web entry is phone-ready, keyboard-operable, and clearly scoped", async ({ page }) => {
  await page.goto("/driver");
  await expect(page.getByRole("heading", { name: "Start your driving day" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Driver login" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in and open itinerary" })).toBeVisible();
  await expect(page.getByLabel("Login ID")).toBeVisible();
  await expect(page.getByText("Synthetic data only.")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
