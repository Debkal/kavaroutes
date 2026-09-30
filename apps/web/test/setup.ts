import "@testing-library/jest-dom/vitest";
import {setBusinessContext} from "../src/business-context";
import { beforeEach,afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0) as unknown as number;
if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);

beforeEach(()=>setBusinessContext({organizationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',principalId:'10000000-0000-4000-8000-000000000001',capabilities:['dispatch:read'],csrf:null,mode:'test'}));
