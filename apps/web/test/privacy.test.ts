import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] { return readdirSync(directory).flatMap((entry) => { const target = path.join(directory, entry); return statSync(target).isDirectory() ? files(target) : [target]; }); }

describe("browser privacy boundary", () => {
  it("contains no persistence, telemetry, Google, or prohibited canary surface", () => {
    const source = files(path.resolve("src")).filter((file) => /\.(ts|tsx|css|html)$/.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|serviceWorker|@googlemaps|maps\.google|analytics|session.?replay/i);
    expect(source).not.toContain("CANARY_REAL_PERSON");
    expect(source).not.toContain("CANARY_SECRET_TOKEN");
  });
});
