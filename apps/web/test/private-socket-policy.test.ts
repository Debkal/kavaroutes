import { expect, it } from "vitest";
import { privateSocketHeaders } from "../private-socket-policy";

const valid = { mode: "private-cloud", url: "/v1/realtime", host: "127.0.0.1:4311",
  origin: "http://127.0.0.1:4311", protocol: "kavaroutes.realtime.v1", remoteAddress: "127.0.0.1" };

it("grants only the exact local dispatcher socket identity", () => {
  expect(privateSocketHeaders(valid)).toEqual({ authorization: "Synthetic principal_dispatcher", origin: "http://kavaroutes.test" });
  for (const patch of [
    { mode: "local-synthetic" }, { mode: undefined }, { url: "/v1/realtime?token=anything" },
    { host: "evil.test:4311" }, { origin: "https://evil.test" }, { origin: undefined },
    { protocol: "kavaroutes.realtime.v1, other" }, { remoteAddress: "192.0.2.1" },
  ]) expect(privateSocketHeaders({ ...valid, ...patch })).toBeNull();
});
