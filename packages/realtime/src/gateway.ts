import { randomUUID } from "node:crypto";
import type { SyntheticPrincipal } from "@kavaroutes/api-contracts";
import { authorizeRealtimeSubscription, type AuthorizationGenerationSource, type AuthorizedSubscription, RealtimeAuthorizationDenied } from "./authorization.js";
import { assertServerFrame, decodeClientFrame, REALTIME_CLOSE_CODES, REALTIME_LIMITS, REALTIME_PROTOCOL, RealtimeProtocolError, type ServerFrame } from "./contracts.js";
import type { RealtimeStore } from "./store.js";
import type { RealtimeTelemetryEvent } from "./telemetry.js";

export interface RealtimeTransport {
  readonly bufferedAmount: number;
  send(text: string): void;
  ping(): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

interface Subscription {
  readonly id: string;
  readonly authorization: AuthorizedSubscription;
  cursor: string;
}

interface Connection {
  readonly id: string;
  readonly principal: SyntheticPrincipal;
  readonly clientClass: "synthetic-web" | "synthetic-native";
  readonly transport: RealtimeTransport;
  readonly subscriptions: Map<string, Subscription>;
  openedAt: number;
  observedAt: number;
  messageWindowStartedAt: number;
  messageCount: number;
  costUnits: number;
  closed: boolean;
}

export interface PresenceHint {
  readonly connectionId: string;
  readonly clientClass: "synthetic-web" | "synthetic-native";
  readonly safeScopeClass: "none" | "dispatch" | "manifest" | "facility" | "operation" | "position";
  readonly lastObservedAt: string;
  readonly expiresAt: string;
}

function safeScopeClass(subscription: Subscription | undefined): PresenceHint["safeScopeClass"] {
  if (!subscription) return "none";
  return ({ DISPATCH_DAY: "dispatch", DRIVER_MANIFEST: "manifest", FACILITY_DAY: "facility", OPERATION: "operation", CURRENT_POSITION: "position" } as const)[subscription.authorization.scope.streamKind];
}

export function createRealtimeGateway(options: {
  readonly store: RealtimeStore;
  readonly generationSource: AuthorizationGenerationSource;
  readonly allowedOrigins?: ReadonlySet<string>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly maximumConnections?: number;
  readonly telemetrySink?: (event: RealtimeTelemetryEvent) => void;
}) {
  const connections = new Map<string, Connection>();
  const allowedOrigins = options.allowedOrigins ?? new Set(["http://kavaroutes.test"]);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `connection:${randomUUID()}`);
  const maximumConnections = options.maximumConnections ?? 1_000;
  let draining = false;
  let peakConnections = 0;

  function emit(event: RealtimeTelemetryEvent): void { options.telemetrySink?.(event); }
  function send(connection: Connection, frame: ServerFrame): boolean {
    assertServerFrame(frame);
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > REALTIME_LIMITS.maximumOutboundBatchBytes || connection.transport.bufferedAmount + Buffer.byteLength(text) > REALTIME_LIMITS.maximumQueuedBytes) {
      try { connection.transport.send(JSON.stringify({ type: "protocol.error", code: "SLOW_CONSUMER" })); } catch { /* close is authoritative */ }
      connection.transport.close(REALTIME_CLOSE_CODES.RETRY.code, REALTIME_CLOSE_CODES.RETRY.reason);
      connection.closed = true;
      emit({ metric: "slow_client", outcome: "closed" });
      return false;
    }
    connection.transport.send(text);
    return true;
  }

  function closeConnection(connection: Connection, code: number, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.subscriptions.clear();
    connection.transport.close(code, reason);
    connections.delete(connection.id);
    emit({ metric: "connection", outcome: "closed", clientClass: connection.clientClass });
  }

  function open(input: { readonly principal: SyntheticPrincipal; readonly origin: string | undefined; readonly protocol: string | undefined; readonly clientClass: "synthetic-web" | "synthetic-native"; readonly transport: RealtimeTransport }): string {
    if (draining || connections.size >= maximumConnections) throw new RealtimeProtocolError("RATE_LIMITED");
    if (input.protocol !== REALTIME_PROTOCOL) throw new RealtimeProtocolError("FRAME_INVALID");
    if (input.clientClass === "synthetic-web" && (input.origin === undefined || !allowedOrigins.has(input.origin))) throw new RealtimeProtocolError("AUTHORIZATION_DENIED");
    const principalCount = [...connections.values()].filter((item) => item.principal.id === input.principal.id).length;
    if (principalCount >= REALTIME_LIMITS.maximumConnectionsPerPrincipal) throw new RealtimeProtocolError("RATE_LIMITED");
    const timestamp = now().getTime();
    const id = idFactory();
    const connection: Connection = { id, principal: input.principal, clientClass: input.clientClass, transport: input.transport,
      subscriptions: new Map(), openedAt: timestamp, observedAt: timestamp, messageWindowStartedAt: timestamp, messageCount: 0, costUnits: 0, closed: false };
    connections.set(id, connection);
    peakConnections = Math.max(peakConnections, connections.size);
    send(connection, { type: "connection.ready", protocol: REALTIME_PROTOCOL, connectionId: id,
      heartbeatMilliseconds: REALTIME_LIMITS.heartbeatMilliseconds, deadPeerGraceMilliseconds: REALTIME_LIMITS.deadPeerGraceMilliseconds,
      limits: { maximumInboundBytes: REALTIME_LIMITS.maximumInboundBytes, maximumOutboundBatchBytes: REALTIME_LIMITS.maximumOutboundBatchBytes,
        maximumChangesPerBatch: REALTIME_LIMITS.maximumChangesPerBatch, maximumSubscriptions: REALTIME_LIMITS.maximumSubscriptionsPerConnection } });
    emit({ metric: "upgrade", outcome: "accepted", clientClass: input.clientClass });
    return id;
  }

  async function receive(connectionId: string, raw: string | Buffer, binary = false): Promise<void> {
    const connection = connections.get(connectionId);
    if (!connection || connection.closed) return;
    connection.observedAt = now().getTime();
    if (binary) { closeConnection(connection, REALTIME_CLOSE_CODES.UNSUPPORTED.code, REALTIME_CLOSE_CODES.UNSUPPORTED.reason); return; }
    if (connection.observedAt - connection.messageWindowStartedAt >= 1_000) { connection.messageWindowStartedAt = connection.observedAt; connection.messageCount = 0; }
    connection.messageCount += 1;
    if (connection.messageCount > 100) { send(connection, { type: "protocol.error", code: "RATE_LIMITED" }); closeConnection(connection, REALTIME_CLOSE_CODES.POLICY.code, REALTIME_CLOSE_CODES.POLICY.reason); return; }
    let frame;
    try { frame = decodeClientFrame(raw); }
    catch (error) {
      const code = error instanceof RealtimeProtocolError ? error.code : "FRAME_INVALID";
      send(connection, { type: "protocol.error", code });
      closeConnection(connection, code === "FRAME_TOO_LARGE" ? REALTIME_CLOSE_CODES.TOO_LARGE.code : REALTIME_CLOSE_CODES.INVALID.code,
        code === "FRAME_TOO_LARGE" ? REALTIME_CLOSE_CODES.TOO_LARGE.reason : REALTIME_CLOSE_CODES.INVALID.reason);
      return;
    }
    if (frame.type === "subscription.unsubscribe") { connection.subscriptions.delete(frame.subscriptionId); return; }
    if (frame.type === "subscription.ack") {
      const subscription = connection.subscriptions.get(frame.subscriptionId);
      if (subscription) subscription.cursor = frame.cursor;
      return;
    }
    if (connection.subscriptions.size >= REALTIME_LIMITS.maximumSubscriptionsPerConnection) { send(connection, { type: "protocol.error", code: "SUBSCRIPTION_LIMIT" }); return; }
    try {
      const authorization = authorizeRealtimeSubscription({ principal: connection.principal, organizationId: frame.organizationId,
        authorizationGeneration: options.generationSource.current(connection.principal.id), purpose: frame.purpose, scope: frame.scope,
        usedCostUnits: connection.costUnits });
      if (!frame.cursor) { send(connection, { type: "subscription.reset-required", subscriptionId: frame.subscriptionId, code: "RESET_REQUIRED" }); emit({ metric: "reset", outcome: "reset" }); return; }
      const replay = await options.store.replay(authorization, frame.cursor);
      if (replay.outcome === "RESET_REQUIRED" || !replay.cursor) { send(connection, { type: "subscription.reset-required", subscriptionId: frame.subscriptionId, code: "RESET_REQUIRED" }); emit({ metric: "reset", outcome: "reset" }); return; }
      const subscription: Subscription = { id: frame.subscriptionId, authorization, cursor: replay.cursor };
      connection.subscriptions.set(frame.subscriptionId, subscription);
      connection.costUnits += authorization.costUnits;
      if (replay.changes.length > 0) send(connection, { type: "change.batch", subscriptionId: frame.subscriptionId, cursor: replay.cursor, changes: replay.changes });
      send(connection, { type: "subscription.live", subscriptionId: frame.subscriptionId, code: "LIVE", cursor: replay.cursor });
      emit({ metric: "subscription", outcome: "accepted" });
    } catch (error) {
      if (error instanceof RealtimeAuthorizationDenied) { send(connection, { type: "protocol.error", code: "AUTHORIZATION_DENIED" }); emit({ metric: "authorization", outcome: "rejected" }); return; }
      send(connection, { type: "protocol.error", code: "INTERNAL_ERROR" });
    }
  }

  async function fanOut(): Promise<number> {
    let batches = 0;
    for (const connection of connections.values()) {
      for (const subscription of connection.subscriptions.values()) {
        const replay = await options.store.replay(subscription.authorization, subscription.cursor);
        if (replay.outcome === "RESET_REQUIRED" || !replay.cursor) { send(connection, { type: "subscription.reset-required", subscriptionId: subscription.id, code: "RESET_REQUIRED" }); connection.subscriptions.delete(subscription.id); continue; }
        if (replay.changes.length > 0 && send(connection, { type: "change.batch", subscriptionId: subscription.id, cursor: replay.cursor, changes: replay.changes })) batches += 1;
        subscription.cursor = replay.cursor;
      }
    }
    emit({ metric: "fanout", outcome: "success", value: batches });
    return batches;
  }

  function heartbeatSweep(): void {
    const timestamp = now().getTime();
    for (const connection of connections.values()) {
      const age = timestamp - connection.observedAt;
      if (age >= REALTIME_LIMITS.deadPeerGraceMilliseconds) { connection.transport.terminate(); connection.closed = true; connections.delete(connection.id); emit({ metric: "heartbeat", outcome: "missed" }); }
      else connection.transport.ping();
    }
  }

  function authorizationSweep(): void {
    for (const connection of connections.values()) {
      for (const subscription of connection.subscriptions.values()) {
        if (options.generationSource.current(connection.principal.id) !== subscription.authorization.authorizationGeneration) {
          send(connection, { type: "subscription.revoked", subscriptionId: subscription.id, code: "AUTHORIZATION_REVOKED" });
          connection.subscriptions.delete(subscription.id);
          emit({ metric: "authorization", outcome: "rejected" });
        }
      }
    }
  }

  function observeHeartbeat(connectionId: string): void { const connection = connections.get(connectionId); if (connection) connection.observedAt = now().getTime(); }
  function presence(): readonly PresenceHint[] {
    const timestamp = now().getTime();
    return Object.freeze([...connections.values()].filter((connection) => !connection.closed).map((connection) => Object.freeze({
      connectionId: connection.id, clientClass: connection.clientClass, safeScopeClass: safeScopeClass(connection.subscriptions.values().next().value as Subscription | undefined),
      lastObservedAt: new Date(connection.observedAt).toISOString(), expiresAt: new Date(Math.max(timestamp, connection.observedAt) + REALTIME_LIMITS.deadPeerGraceMilliseconds).toISOString(),
    })));
  }
  function drain(): void { draining = true; for (const connection of [...connections.values()]) { send(connection, { type: "server.draining", code: "SERVER_DRAINING" }); closeConnection(connection, REALTIME_CLOSE_CODES.RESTART.code, REALTIME_CLOSE_CODES.RESTART.reason); } }

  return Object.freeze({ open, receive, fanOut, heartbeatSweep, authorizationSweep, observeHeartbeat, presence, drain,
    close(connectionId: string) { const connection = connections.get(connectionId); if (connection) closeConnection(connection, REALTIME_CLOSE_CODES.NORMAL.code, REALTIME_CLOSE_CODES.NORMAL.reason); },
    activeConnections: () => connections.size, peakConnections: () => peakConnections, isDraining: () => draining });
}
