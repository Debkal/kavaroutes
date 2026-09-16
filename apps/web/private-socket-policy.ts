/** Local development identity bridge only; never used by a hosted build. */
export function privateSocketHeaders(input: {
  mode: string | undefined;
  url: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  protocol: string | string[] | undefined;
  remoteAddress: string | undefined;
}): Readonly<Record<string, string>> | null {
  if (input.mode !== "private-cloud" || input.url !== "/v1/realtime" ||
      input.host !== "127.0.0.1:4311" || input.origin !== "http://127.0.0.1:4311" ||
      input.protocol !== "kavaroutes.realtime.v1" ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(input.remoteAddress ?? "")) return null;
  return Object.freeze({ authorization: "Synthetic principal_dispatcher", origin: "http://kavaroutes.test" });
}
