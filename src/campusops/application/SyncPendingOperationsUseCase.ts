import { resolveSync } from '../../course-evaluation';
import type { QueuedOperation } from '../contracts';
import type {
  ActionOutcome,
  IncidentSyncGateway,
  RejectionCode,
  RemoteIncidentSnapshot,
} from '../domain/IncidentSyncGateway';
import {
  belongsToOperation,
  changedFieldNames,
  intendedFields,
  readSyncBase,
  rebasedOperationId,
  sameJson,
} from '../domain/OfflineSync';
import type { SyncFields } from '../domain/OfflineSync';
import type { OperationQueueRepository } from '../domain/OperationQueueRepository';

/**
 * Week 08 — sends the persisted queue to the server once the connection is
 * back. Policy and rationale: docs/sync-policy.md. Rules enforced here:
 *
 * - An entry leaves the queue ONLY when the server confirms its effect
 *   (applied, replayed duplicate, or already present in the server history).
 * - Timeouts, network/5xx/429 errors and missing sessions keep it `queued`.
 * - 403 (RBAC/reassignment), same-field conflicts, reused keys and invalid
 *   operations mark it `conflict`: it stays in the queue for a person to resolve.
 * - Independent remote changes are combined with `resolveSync` and the
 *   intention is re-sent on top of the remote version with a deterministic id.
 * - Later entries of an incident wait while an earlier one is not confirmed.
 */

export type SyncReason =
  | 'applied'
  | 'replayed_duplicate'
  | 'already_applied'
  | 'rebased_independent_changes'
  | 'concurrent_field_conflict'
  | 'forbidden'
  | 'idempotency_key_reused'
  | 'transition_conflict'
  | 'invalid_operation'
  | 'base_unknown'
  | 'awaiting_resolution'
  | 'blocked_by_previous_operation'
  | 'remote_changed_again'
  | 'unauthenticated'
  | 'timeout'
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'invalid_response';

export type SyncOutcome = Readonly<{
  operationId: string;
  incidentId: string;
  result: 'confirmed' | 'conflict' | 'pending';
  reason: SyncReason;
  /** Idempotency key whose effect the server confirmed (original or rebased). */
  appliedWith?: string;
  conflictFields?: readonly string[];
  mergedFields?: SyncFields;
  retryAfterMs?: number;
}>;

export type SyncSummary = Readonly<{
  outcomes: readonly SyncOutcome[];
  confirmed: number;
  conflicts: number;
  pending: number;
  /** Consecutive cycles that ended with retryable pending work (0 when none). */
  failedCycles: number;
  /** Suggested wait before the next cycle, or null when no retryable work remains. */
  nextAttemptInMs: number | null;
}>;

export type ConflictReview =
  | Readonly<{ kind: 'merged'; fields: SyncFields }>
  | Readonly<{ kind: 'conflict'; fields: readonly string[] }>
  | Readonly<{ kind: 'base_unknown' }>;

export const SYNC_BACKOFF_BASE_MS = 1_000;
export const SYNC_BACKOFF_MAX_MS = 30_000;
export const SYNC_RETRY_AFTER_MAX_MS = 300_000;

/**
 * Delay before the next synchronization cycle: exponential (1 s, 2 s, 4 s …)
 * capped at 30 s, and never shorter than a valid Retry-After (capped at 5 min).
 * Always finite. Bounded per-request retries belong to Week 09 (`planRetry`).
 */
export function nextSyncDelayMs(failedCycles: number, retryAfterMs?: number): number {
  const cycles = Number.isFinite(failedCycles) && failedCycles >= 1 ? Math.floor(failedCycles) : 1;
  const exponential = Math.min(SYNC_BACKOFF_MAX_MS, SYNC_BACKOFF_BASE_MS * 2 ** Math.min(cycles - 1, 30));
  const hinted = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(retryAfterMs, SYNC_RETRY_AFTER_MAX_MS)
    : 0;
  return Math.max(exponential, hinted);
}

/**
 * 3-way comparison of a queued intention against a remote snapshot, using the
 * same `resolveSync` evaluated by the course contract. It does not mutate the
 * operation or the snapshot. Coordination can use it to see which fields clash.
 */
export function reviewConflict(operation: QueuedOperation, remote: RemoteIncidentSnapshot): ConflictReview {
  const base = readSyncBase(operation);
  if (!base) return { kind: 'base_unknown' };
  const local = intendedFields(base.fields, operation.action, operation.payload);
  return resolveSync(
    { id: operation.incidentId, version: base.version, fields: base.fields },
    { id: operation.incidentId, version: base.version, fields: local },
    { id: remote.id, version: remote.version, fields: remote.fields },
  );
}

const REJECTION_REASONS: Readonly<Record<Exclude<RejectionCode, 'version_conflict'>, SyncReason>> = {
  forbidden: 'forbidden',
  idempotency_key_reused: 'idempotency_key_reused',
  transition_conflict: 'transition_conflict',
  invalid: 'invalid_operation',
};

const RETRYABLE_REASONS: ReadonlySet<SyncReason> = new Set<SyncReason>([
  'timeout', 'network', 'server', 'rate_limited', 'invalid_response', 'remote_changed_again',
]);

function outcome(
  operation: QueuedOperation,
  result: SyncOutcome['result'],
  reason: SyncReason,
  extra: Partial<Pick<SyncOutcome, 'appliedWith' | 'conflictFields' | 'mergedFields' | 'retryAfterMs'>> = {},
): SyncOutcome {
  return {
    operationId: operation.operationId,
    incidentId: operation.incidentId,
    result,
    reason,
    ...(extra.appliedWith !== undefined ? { appliedWith: extra.appliedWith } : {}),
    ...(extra.conflictFields !== undefined ? { conflictFields: extra.conflictFields } : {}),
    ...(extra.mergedFields !== undefined ? { mergedFields: extra.mergedFields } : {}),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
  };
}

export class SyncPendingOperationsUseCase {
  constructor(private readonly deps: Readonly<{
    queue: OperationQueueRepository;
    gateway: IncidentSyncGateway;
  }>) {}

  async execute(options: Readonly<{ previousFailedCycles?: number }> = {}): Promise<SyncSummary> {
    const operations = await this.deps.queue.list();
    const waitingIncidents = new Set<string>();
    const outcomes: SyncOutcome[] = [];
    let sessionLost = false;

    for (const operation of operations) {
      let current: SyncOutcome;
      if (sessionLost) {
        current = outcome(operation, 'pending', 'unauthenticated');
      } else if (operation.status === 'conflict') {
        current = outcome(operation, 'conflict', 'awaiting_resolution');
      } else if (waitingIncidents.has(operation.incidentId)) {
        current = outcome(operation, 'pending', 'blocked_by_previous_operation');
      } else {
        current = await this.synchronize(operation);
      }
      if (current.reason === 'unauthenticated') sessionLost = true;
      if (current.result !== 'confirmed') waitingIncidents.add(operation.incidentId);
      outcomes.push(current);
    }

    const retryable = outcomes.filter((item) => RETRYABLE_REASONS.has(item.reason));
    const previous = options.previousFailedCycles ?? 0;
    const failedCycles = retryable.length > 0 ? Math.max(0, Math.floor(previous)) + 1 : 0;
    const retryAfter = Math.max(0, ...retryable.map((item) => item.retryAfterMs ?? 0));
    return {
      outcomes,
      confirmed: outcomes.filter((item) => item.result === 'confirmed').length,
      conflicts: outcomes.filter((item) => item.result === 'conflict').length,
      pending: outcomes.filter((item) => item.result === 'pending').length,
      failedCycles,
      nextAttemptInMs: failedCycles > 0 ? nextSyncDelayMs(failedCycles, retryAfter || undefined) : null,
    };
  }

  private submit(operation: QueuedOperation, idempotencyKey: string, baseVersion: number): Promise<ActionOutcome> {
    return this.deps.gateway.submitAction({
      idempotencyKey,
      incidentId: operation.incidentId,
      action: operation.action,
      baseVersion,
      payload: operation.payload,
    });
  }

  private async confirm(
    operation: QueuedOperation,
    reason: SyncReason,
    appliedWith: string,
    mergedFields?: SyncFields,
  ): Promise<SyncOutcome> {
    await this.deps.queue.markConfirmed(operation.operationId);
    return outcome(operation, 'confirmed', reason, {
      appliedWith,
      ...(mergedFields !== undefined ? { mergedFields } : {}),
    });
  }

  private async conflict(
    operation: QueuedOperation,
    reason: SyncReason,
    conflictFields?: readonly string[],
  ): Promise<SyncOutcome> {
    await this.deps.queue.markConflict(operation.operationId);
    return outcome(operation, 'conflict', reason, conflictFields !== undefined ? { conflictFields } : {});
  }

  private async synchronize(operation: QueuedOperation): Promise<SyncOutcome> {
    const first = await this.submit(operation, operation.operationId, operation.baseVersion);
    switch (first.kind) {
      case 'applied':
        return this.confirm(operation, first.duplicate ? 'replayed_duplicate' : 'applied', operation.operationId);
      case 'unauthenticated':
        return outcome(operation, 'pending', 'unauthenticated');
      case 'unavailable':
        return outcome(operation, 'pending', first.code, first.retryAfterMs !== undefined ? { retryAfterMs: first.retryAfterMs } : {});
      case 'rejected':
        return first.code === 'version_conflict'
          ? this.reconcile(operation)
          : this.conflict(operation, REJECTION_REASONS[first.code]);
    }
  }

  /** The base version is obsolete: compare base, local intention and remote state. */
  private async reconcile(operation: QueuedOperation): Promise<SyncOutcome> {
    const remote = await this.deps.gateway.fetchSnapshot(operation.incidentId);
    if (remote.kind === 'forbidden') return this.conflict(operation, 'forbidden');
    if (remote.kind === 'unavailable') return outcome(operation, 'pending', remote.code);

    const snapshot = remote.snapshot;
    const recorded = snapshot.appliedOperationIds.find((id) => belongsToOperation(id, operation.operationId));
    if (recorded !== undefined) return this.confirm(operation, 'already_applied', recorded);

    const base = readSyncBase(operation);
    if (!base) return this.conflict(operation, 'base_unknown');
    const review = reviewConflict(operation, snapshot);
    if (review.kind === 'base_unknown') return this.conflict(operation, 'base_unknown');
    if (review.kind === 'conflict') return this.conflict(operation, 'concurrent_field_conflict', review.fields);

    const intended = intendedFields(base.fields, operation.action, operation.payload);
    const changed = changedFieldNames(base.fields, intended);
    if (changed.length > 0 && changed.every((name) => sameJson(snapshot.fields[name], intended[name]))) {
      // The remote state already contains exactly this intention: nothing left to send.
      return this.confirm(operation, 'already_applied', operation.operationId, review.fields);
    }

    const rebasedKey = rebasedOperationId(operation.operationId, snapshot.version);
    const second = await this.submit(operation, rebasedKey, snapshot.version);
    switch (second.kind) {
      case 'applied':
        return this.confirm(operation, 'rebased_independent_changes', rebasedKey, review.fields);
      case 'unauthenticated':
        return outcome(operation, 'pending', 'unauthenticated');
      case 'unavailable':
        return outcome(operation, 'pending', second.code, second.retryAfterMs !== undefined ? { retryAfterMs: second.retryAfterMs } : {});
      case 'rejected':
        // Another change landed between the read and the re-send: analyse again next cycle.
        return second.code === 'version_conflict'
          ? outcome(operation, 'pending', 'remote_changed_again')
          : this.conflict(operation, REJECTION_REASONS[second.code]);
    }
  }
}
