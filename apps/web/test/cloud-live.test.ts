import { afterEach, expect, it, vi } from "vitest";
import { connectCloudDispatch } from "../src/cloud-live";

afterEach(() => vi.useRealTimers());
const first = `rtc1.${"a".repeat(48)}`;
const next = `rtc1.${"b".repeat(48)}`;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(refresh = vi.fn(async () => {})) {
  const sockets: { onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  const snapshot = vi.fn(async () => first);
  const stop = connectCloudDispatch({ origin: "http://127.0.0.1:4311", serviceDate: "2026-09-13", snapshot,
    refresh, status: vi.fn(), socket: () => {
      const socket = { onmessage: null, onclose: null, send: vi.fn(), close: vi.fn() };
      sockets.push(socket); return socket as unknown as WebSocket;
    } });
  const message = (index: number, frame: unknown) => sockets[index]!.onmessage?.({ data: JSON.stringify(frame) });
  return { sockets, snapshot, refresh, stop, message };
}
const ready = { type: "connection.ready", protocol: "kavaroutes.realtime.v1" };
const change = { type: "change.batch", subscriptionId: "subscription:web:dispatch", cursor: next, changes: [{}] };

it('uses the current private loopback port for Compose, never the cloud tunnel port', async()=>{
  const socket=vi.fn(()=>({close:vi.fn()}) as unknown as WebSocket);
  const stop=connectCloudDispatch({origin:'http://127.0.0.1:8080',serviceDate:'2026-09-15',snapshot:async()=>first,refresh:async()=>{},status:()=>{},socket});
  await flush();expect(socket).toHaveBeenCalledWith('ws://127.0.0.1:8080/v1/realtime','kavaroutes.realtime.v1');stop();
});

it.each(['http://example.com:8080','http://localhost:8080','http://127.0.0.1','https://127.0.0.1:8080','http://127.0.0.1:8080/path','http://user@127.0.0.1:8080'])('rejects non-private socket origin %s',origin=>{
  expect(()=>connectCloudDispatch({origin,serviceDate:'2026-09-15',snapshot:async()=>first,refresh:async()=>{},status:()=>{}})).toThrow('PRIVATE_SOCKET_ORIGIN_REQUIRED');
});

it("acknowledges only after refresh and reconnects with the applied cursor", async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const refresh = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const h = harness(refresh); await flush(); h.message(0, ready); await flush();
  h.message(0, change); await flush();
  expect(h.sockets[0]!.send).toHaveBeenCalledTimes(1);
  complete(); await flush();
  expect(JSON.parse(h.sockets[0]!.send.mock.calls[1]![0])).toMatchObject({ type: "subscription.ack", cursor: next });
  h.sockets[0]!.onclose?.(); await vi.advanceTimersByTimeAsync(500); h.message(1, ready); await flush();
  expect(JSON.parse(h.sockets[1]!.send.mock.calls[0]![0]).cursor).toBe(next);
  h.stop();
});

it("keeps the prior cursor when refresh fails and clears it on reset", async () => {
  vi.useFakeTimers();
  const h = harness(vi.fn(async () => { throw Error("offline"); })); await flush();
  h.message(0, ready); await flush(); h.message(0, change); await flush();
  expect(h.sockets[0]!.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500); h.message(1, ready); await flush();
  expect(JSON.parse(h.sockets[1]!.send.mock.calls[0]![0]).cursor).toBe(first);
  h.message(1, { type: "subscription.reset-required", subscriptionId: "subscription:web:dispatch" }); await flush();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.snapshot).toHaveBeenCalledTimes(2);
  h.stop(); const count = h.sockets.length; await vi.advanceTimersByTimeAsync(60_000);
  expect(h.sockets).toHaveLength(count);
});
