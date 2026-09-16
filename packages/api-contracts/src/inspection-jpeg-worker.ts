import { parentPort, workerData } from "node:worker_threads";
import jpeg from "jpeg-js";
try {
  const image = jpeg.decode(workerData as Uint8Array, { useTArray: true, tolerantDecoding: false,
    maxResolutionInMP: 2, maxMemoryUsageInMB: 32 });
  if (!image.width || !image.height || image.width > 2048 || image.height > 2048 || image.data.length !== image.width * image.height * 4) throw new Error("INVALID_IMAGE");
  parentPort?.postMessage(true);
} catch { parentPort?.postMessage(false); }
