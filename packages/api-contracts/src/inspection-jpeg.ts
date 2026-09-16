import { Worker } from "node:worker_threads";
import { ProtocolError } from "./protocol.js";
let active = 0;
export async function validateInspectionJpeg(content: Uint8Array): Promise<void> {
  if (active >= 2) throw new ProtocolError(503, "PHOTO_VALIDATOR_BUSY", "retry saved command");
  active++;
  let worker: Worker | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      worker = new Worker(new URL("./inspection-jpeg-worker.js", import.meta.url), { workerData: content,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
      const timer = setTimeout(() => reject(new ProtocolError(422, "DEFECT_PHOTO_FORMAT_INVALID", "photo validation exceeded bounds")), 1000);
      const fail = () => { clearTimeout(timer); reject(new ProtocolError(422, "DEFECT_PHOTO_FORMAT_INVALID", "photo decoder rejected image")); };
      worker.once("message", value => { clearTimeout(timer); if (value === true) resolve(); else fail(); });
      worker.once("error", fail); worker.once("exit", code => { if (code !== 0) fail(); });
    });
  } finally { if (worker) await worker.terminate(); active--; }
}
