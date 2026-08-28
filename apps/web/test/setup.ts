import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0) as unknown as number;
if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
