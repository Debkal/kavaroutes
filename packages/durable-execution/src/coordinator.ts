import type { OutboxRoute } from "./contracts.js";
import type { DeliveryLease } from "./store.js";

export interface ClaimSource {
  claimEligible(input: { tenantId: string; publisherId: string; route: OutboxRoute; limit: number; leaseMilliseconds: number }): Promise<readonly DeliveryLease[]>;
}

export function coalesceLocationBatchSignals(input: { readonly driverReference: string; readonly aggregateReference: string; readonly windowStartedAt: string }[]): readonly { readonly driverReference: string; readonly aggregateReference: string; readonly windowStartedAt: string }[] {
  const signals = new Map<string, { readonly driverReference: string; readonly aggregateReference: string; readonly windowStartedAt: string }>();
  for (const item of input) {
    if (!/^[0-9a-f-]{36}$/i.test(item.driverReference) || !/^[0-9a-f-]{36}$/i.test(item.aggregateReference) || !Number.isFinite(Date.parse(item.windowStartedAt))) throw new Error("INVALID_LOCATION_SIGNAL_REFERENCE");
    signals.set(`${item.driverReference}:${item.aggregateReference}:${item.windowStartedAt}`, Object.freeze({ ...item }));
  }
  return Object.freeze([...signals.values()]);
}

export function createPublisherCoordinator(source: ClaimSource, options: { readonly tenantIds: readonly string[]; readonly routes: readonly OutboxRoute[];
  readonly batchSize: number; readonly leaseMilliseconds: number; readonly maxBackgroundConnections: number }) {
  if (options.tenantIds.length < 1 || options.routes.length < 1 || !Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100 ||
    !Number.isInteger(options.maxBackgroundConnections) || options.maxBackgroundConnections < 1 || options.maxBackgroundConnections > 8) throw new Error("INVALID_COORDINATOR_BOUNDS");
  let cursor = 0;
  let accepting = true;
  const active = new Set<Promise<void>>();
  return Object.freeze({
    get state(): "RUNNING" | "DRAINING" | "STOPPED" { return accepting ? "RUNNING" : active.size ? "DRAINING" : "STOPPED"; },
    async runCycle(publisherId: string, handle: (lease: DeliveryLease) => Promise<void>): Promise<{ readonly claimed: number; readonly tenantOrder: readonly string[] }> {
      if (!accepting || active.size >= options.maxBackgroundConnections) return { claimed: 0, tenantOrder: [] };
      const tenantOrder = [...options.tenantIds.slice(cursor), ...options.tenantIds.slice(0, cursor)];
      cursor = (cursor + 1) % options.tenantIds.length;
      const leases: DeliveryLease[] = [];
      for (const route of options.routes) {
        for (const tenantId of tenantOrder) {
          if (!accepting || leases.length >= options.batchSize) break;
          const fairShare = Math.max(1, Math.floor((options.batchSize - leases.length) / Math.max(1, options.tenantIds.length)));
          leases.push(...await source.claimEligible({ tenantId, publisherId, route, limit: fairShare, leaseMilliseconds: options.leaseMilliseconds }));
        }
      }
      for (const lease of leases.slice(0, options.batchSize)) {
        while (active.size >= options.maxBackgroundConnections) await Promise.race(active);
        let work: Promise<void>;
        work = handle(lease).finally(() => active.delete(work));
        active.add(work);
      }
      await Promise.all(active);
      return { claimed: Math.min(leases.length, options.batchSize), tenantOrder };
    },
    async shutdown(): Promise<void> {
      accepting = false;
      await Promise.all(active);
    },
  });
}
