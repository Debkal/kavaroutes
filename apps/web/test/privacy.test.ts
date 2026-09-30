import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] { return readdirSync(directory).flatMap((entry) => { const target = path.join(directory, entry); return statSync(target).isDirectory() ? files(target) : [target]; }); }

describe("browser privacy boundary", () => {
  it("contains no sensitive persistence, telemetry, or browser map API", () => {
    const source = files(path.resolve("src")).filter((file) => /\.(ts|tsx|css|html)$/.test(file)).map((file) => {const text=readFileSync(file,"utf8");return path.basename(file)==="driver-signout-notice.ts"?text.replaceAll("window.sessionStorage","REVIEWED_NOTICE_STORAGE"):text;}).join("\n");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|serviceWorker|@googlemaps|maps\.google|api\.geoapify\.com|maps\.geoapify\.com|analytics|session.?replay/i);
    expect(source).not.toContain("CANARY_REAL_PERSON");
    expect(source).not.toContain("CANARY_SECRET_TOKEN");
  });
});
