/** Socket frames invalidate REST state; they never supply trip or shift authority. */
export function connectCloudDispatch(options: {
  origin: string;
  serviceDate: string;
  snapshot(): Promise<string>;
  refresh(): Promise<void>;
  status(value: "connecting" | "live" | "reconnecting" | "unavailable"): void;
  socket?: (url: string, protocol: string) => WebSocket;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || Number(origin.port)<1024 || origin.pathname !== "/" ||
      origin.username || origin.password || origin.search || origin.hash || !/^\d{4}-\d{2}-\d{2}$/.test(options.serviceDate)) throw new Error("PRIVATE_SOCKET_ORIGIN_REQUIRED");
  const validCursor = (value: unknown): value is string => typeof value === "string" && /^rtc1\.[A-Za-z0-9_-]{48,8192}$/.test(value);
  const subscriptionId = "subscription:web:dispatch";
  let stopped = false;
  let cursor: string | undefined;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;

  function retry() {
    if (stopped || timer) return;
    options.status("reconnecting");
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6));
    timer = setTimeout(() => { timer = undefined; void open(); }, delay);
  }
  async function open() {
    const current = ++generation;
    options.status("connecting");
    const active = () => !stopped && current === generation;
    try {
      if (!cursor) {
        const value = await options.snapshot();
        if (!active()) return;
        if (!validCursor(value)) throw new Error("INVALID_SNAPSHOT_CURSOR");
        cursor = value;
      }
      if (!active()) return;
      const connection = (options.socket ?? ((url, protocol) => new WebSocket(url, protocol)))(
        `ws://${origin.host}/v1/realtime`, "kavaroutes.realtime.v1");
      socket = connection;
      let work = Promise.resolve();
      let queued = 0;
      const fail = () => {
        if (!active()) return;
        ++generation; clearTimeout(watchdog); connection.close(); retry();
      };
      watchdog = setTimeout(fail, 20_000);
      connection.onclose = fail;
      connection.onerror = fail;
      connection.onmessage = event => {
        if (!active()) return;
        if (typeof event.data !== "string" || event.data.length > 262_144 || ++queued > 32) { fail(); return; }
        work = work.then(async () => {
          if (!active()) return;
          const frame = JSON.parse(event.data);
          if (!frame || typeof frame !== "object") throw new Error("INVALID_FRAME");
          if (frame.type === "connection.ready" && frame.protocol === "kavaroutes.realtime.v1") {
            connection.send(JSON.stringify({ type: "subscription.subscribe", messageId: "message:web:subscribe", subscriptionId,
              organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", purpose: "DISPATCH_CONTROL",
              scope: { streamKind: "DISPATCH_DAY", scopeReference: "branch:synthetic-all", serviceDate: options.serviceDate }, cursor }));
          } else if (frame.type === "subscription.live" && frame.subscriptionId === subscriptionId && frame.code === "LIVE") {
            clearTimeout(watchdog); attempt = 0; options.status("live");
          } else if (frame.type === "change.batch" && frame.subscriptionId === subscriptionId && validCursor(frame.cursor) &&
              Array.isArray(frame.changes) && frame.changes.length > 0 && frame.changes.length <= 100) {
            // Retain the previous cursor if REST refresh fails; replay on reconnect.
            // Untrusted delta contents are never projected into the UI.
            await options.refresh();
            if (!active()) return;
            cursor = frame.cursor;
            connection.send(JSON.stringify({ type: "subscription.ack", messageId: "message:web:ack", subscriptionId, cursor }));
          } else if (frame.type === "subscription.reset-required" && frame.subscriptionId === subscriptionId) {
            cursor = undefined; fail();
          } else if (frame.type === "subscription.revoked" && frame.subscriptionId === subscriptionId) {
            stopped = true; clearTimeout(watchdog); connection.close(); options.status("unavailable");
          } else throw new Error("UNSUPPORTED_FRAME");
        }).catch(fail).finally(() => { queued--; });
      };
    } catch { if (active()) retry(); }
  }
  void open();
  return () => { stopped = true; generation++; clearTimeout(timer); clearTimeout(watchdog); socket?.close(); };
}
