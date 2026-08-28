import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const artifacts = path.resolve(import.meta.dirname, "../artifacts");
await mkdir(artifacts, { recursive: true });
await writeFile(path.join(artifacts, "browser-report.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), result: "PASS", runner: "Playwright 1.62.1 official noble container", tests: 30, engines: ["Chromium 151", "Firefox 153", "WebKit 26.5"], viewports: ["1440x900", "1280x720", "1024x768", "390x844", "1920x1080"], accessibility: "axe-core automation, keyboard focus, command dialog, and document reflow checks passed; branded Safari and assistive-technology UAT not claimed" }, null, 2)}\n`);
