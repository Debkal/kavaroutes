import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { ThinJobPayload } from "./contracts.js";
import { ROUTE_POLICIES } from "./policies.js";

export interface EnrolledJob { readonly transportReference: string; readonly duplicate: boolean; }
export interface TransactionalTransport {
  readonly supportsAtomicEnrollment: true;
  send(client: PoolClient, payload: ThinJobPayload): Promise<EnrolledJob>;
}

export function createPgBossTransactionalTransport(boss: PgBoss): TransactionalTransport {
  return Object.freeze({
    supportsAtomicEnrollment: true as const,
    async send(client: PoolClient, payload: ThinJobPayload) {
      const route = ROUTE_POLICIES[payload.route];
      const reference = await boss.send(route.queue, payload, {
        db: { executeSql: async (text, values) => client.query(text, values) },
        singletonKey: payload.deliveryId,
        singletonSeconds: 2_592_000,
        retryLimit: 0,
        expireInSeconds: route.executionTimeoutSeconds,
        retentionSeconds: 2_592_000,
        priority: route.priority,
      });
      return reference === null ? { transportReference: `duplicate_${payload.deliveryId}`, duplicate: true }
        : { transportReference: reference, duplicate: false };
    },
  });
}

export interface FakeTransportControl { readonly failBeforeEnrollment?: boolean; readonly loseAcknowledgement?: boolean; readonly loseAcknowledgementOnce?: boolean; }

export function createDeterministicFakeTransport(control: FakeTransportControl = {}): TransactionalTransport & { readonly enrolled: Map<string, ThinJobPayload> } {
  const enrolled = new Map<string, ThinJobPayload>();
  let acknowledgementLost = false;
  return Object.freeze({
    supportsAtomicEnrollment: true as const,
    enrolled,
    async send(_client: PoolClient, payload: ThinJobPayload) {
      if (control.failBeforeEnrollment) throw new Error("TRANSIENT_DEPENDENCY");
      const duplicate = enrolled.has(payload.deliveryId);
      enrolled.set(payload.deliveryId, payload);
      if (control.loseAcknowledgement || (control.loseAcknowledgementOnce && !acknowledgementLost)) {
        acknowledgementLost = true;
        throw new Error("SYNTHETIC_ACK_LOST");
      }
      return { transportReference: `fake_${payload.deliveryId}`, duplicate };
    },
  });
}
