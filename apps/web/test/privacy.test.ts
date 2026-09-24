import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] { return readdirSync(directory).flatMap((entry) => { const target = path.join(directory, entry); return statSync(target).isDirectory() ? files(target) : [target]; }); }

describe("browser privacy boundary", () => {
  it("contains no persistence, telemetry, or unapproved Google surface", () => {
    const source = files(path.resolve("src")).filter((file) => /\.(ts|tsx|css|html)$/.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
    // The dispatcher may load only the selected route's Static Maps image
    // directly from Google; the browser still cannot load a Maps SDK.
    const approvedImageHost = "https://maps.googleapis.com/maps/api/staticmap?";
    expect(source.replaceAll(approvedImageHost, "")).not.toMatch(/localStorage|sessionStorage|indexedDB|serviceWorker|@googlemaps|maps\.google|analytics|session.?replay/i);
    expect(source).not.toContain("CANARY_REAL_PERSON");
    expect(source).not.toContain("CANARY_SECRET_TOKEN");
  });
});
