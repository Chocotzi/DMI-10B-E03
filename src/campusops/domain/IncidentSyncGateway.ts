import type { SyncFields } from './OfflineSync';

/**
 * Port used by the synchronization use case to talk to the CampusOps service
 * (Week 08). The HTTP adapter lives in
 * `infrastructure/HttpIncidentSyncGateway.ts`; tests may use deterministic
 * doubles. The server stays the authority for RBAC (Week 06) and versions.
 */
export type ActionSubmission = Readonly<{
  /** Sent as `Idempotency-Key`; equals the queued `operationId` (or its rebase id). */
  idempotencyKey: string;
  incidentId: string;
  action: string;
  baseVersion: number;
  payload: Readonly<Record<string, unknown>>;
}>;

export type RejectionCode =
  | 'forbidden'
  | 'version_conflict'
  | 'idempotency_key_reused'
  | 'transition_conflict'
  | 'invalid';

export type UnavailableCode = 'timeout' | 'network' | 'server' | 'rate_limited' | 'invalid_response';

export type ActionOutcome =
  /** The server applied the effect; `duplicate` means it had already been applied with this key. */
  | Readonly<{ kind: 'applied'; duplicate: boolean; version: number }>
  /** The server refused it; nothing changed remotely. */
  | Readonly<{ kind: 'rejected'; code: RejectionCode; status: number }>
  | Readonly<{ kind: 'unauthenticated' }>
  /** No reliable answer (the server may or may not have applied it). */
  | Readonly<{ kind: 'unavailable'; code: UnavailableCode; retryAfterMs?: number }>;

export type RemoteIncidentSnapshot = Readonly<{
  id: string;
  version: number;
  fields: SyncFields;
  /** Idempotency keys recorded in the server history for this incident. */
  appliedOperationIds: readonly string[];
}>;

export type SnapshotOutcome =
  | Readonly<{ kind: 'visible'; snapshot: RemoteIncidentSnapshot }>
  /** The actor can no longer see the incident (e.g. it was reassigned). */
  | Readonly<{ kind: 'forbidden' }>
  | Readonly<{ kind: 'unavailable'; code: UnavailableCode | 'unauthenticated' }>;

export interface IncidentSyncGateway {
  submitAction(submission: ActionSubmission): Promise<ActionOutcome>;
  fetchSnapshot(incidentId: string): Promise<SnapshotOutcome>;
}
