import type { QueuedOperation } from '../contracts';

/**
 * Week 08 — domain rules shared by the offline queue (schema v2) and the
 * synchronization use case. See docs/sync-policy.md and docs/data-model.md §4.
 *
 * `fields` is the comparable part of an incident for the 3-way merge
 * (`resolveSync`). In CampusOps `work` groups `{ assignedTechnicianId, status }`,
 * so a remote reassignment and a local "start" touch the same field.
 */
export type SyncFields = Readonly<Record<string, unknown>>;

/** Incident snapshot the device had when the operation was created (its base). */
export type SyncBase = Readonly<{ version: number; fields: SyncFields }>;

/**
 * Queue entry of schema v2: the v1 entry (`QueuedOperation`) plus the base
 * snapshot. Without it the client could not tell an independent remote change
 * from a conflicting one after a restart. `null` means "unknown base" (e.g. an
 * entry migrated from v1 whose cached incident had a different version).
 */
export type SyncableOperation = QueuedOperation & Readonly<{ base?: SyncBase | null }>;

/** Separator of the deterministic identity used when an operation is rebased. */
export const REBASE_SEPARATOR = ':rebase:v';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isSyncBase(value: unknown): value is SyncBase {
  return isRecord(value)
    && Number.isSafeInteger(value.version)
    && (value.version as number) >= 0
    && isRecord(value.fields);
}

/** Returns the stored base only when it matches the operation's `baseVersion`. */
export function readSyncBase(operation: QueuedOperation): SyncBase | null {
  const candidate: unknown = (operation as { base?: unknown }).base;
  return isSyncBase(candidate) && candidate.version === operation.baseVersion ? candidate : null;
}

/**
 * Builds the queue entry for an intention captured without connection. The
 * caller generates `operationId` once (it becomes the Idempotency-Key) and the
 * entry is persisted before anything is sent.
 */
export function createOfflineOperation(input: Readonly<{
  operationId: string;
  incidentId: string;
  actorId: string;
  action: string;
  payload: Readonly<Record<string, unknown>>;
  base: SyncBase;
  createdAt: string;
}>): SyncableOperation {
  if (!nonempty(input.operationId) || input.operationId.length < 8) {
    throw new Error('operationId must be a stable identifier of at least 8 characters');
  }
  if (!nonempty(input.incidentId) || !nonempty(input.actorId) || !nonempty(input.action)) {
    throw new Error('incidentId, actorId and action are required');
  }
  if (!isSyncBase(input.base)) {
    throw new Error('base must contain an integer version and comparable fields');
  }
  return {
    operationId: input.operationId,
    incidentId: input.incidentId,
    baseVersion: input.base.version,
    actorId: input.actorId,
    action: input.action,
    payload: { ...input.payload },
    status: 'queued',
    createdAt: input.createdAt,
    base: { version: input.base.version, fields: { ...input.base.fields } },
  };
}

function workOf(fields: SyncFields): Readonly<Record<string, unknown>> | null {
  return isRecord(fields.work) ? fields.work : null;
}

/**
 * Fields as they would look locally after applying the intention to its base.
 * Never mutates `base`. Additive actions (`comment`, `add_evidence`) do not
 * change comparable fields: they are not decided by the 3-way merge.
 */
export function intendedFields(
  base: SyncFields,
  action: string,
  payload: Readonly<Record<string, unknown>>,
): SyncFields {
  const work = workOf(base);
  const withWork = (changes: Readonly<Record<string, unknown>>): SyncFields => (
    work ? { ...base, work: { ...work, ...changes } } : base
  );
  switch (action) {
    case 'start':
      return withWork({ status: 'in_progress' });
    case 'resolve': {
      const next = withWork({ status: 'resolved' });
      return typeof payload.diagnosis === 'string' ? { ...next, diagnosis: payload.diagnosis } : next;
    }
    case 'assign':
      return withWork({ assignedTechnicianId: payload.technicianId ?? null, status: 'assigned' });
    case 'prioritize':
      return { ...base, priority: payload.priority };
    case 'close':
      return withWork({ status: 'closed' });
    case 'reopen':
      return withWork({ status: work && nonempty(work.assignedTechnicianId) ? 'assigned' : 'open' });
    default:
      return base;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Compares by JSON content (key order does not matter), never by object identity. */
export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Names of the fields whose JSON content differs, in name order. */
export function changedFieldNames(before: SyncFields, after: SyncFields): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => !sameJson(before[name], after[name])).sort();
}

/**
 * Deterministic identity for re-sending an intention on top of a newer remote
 * version. The same rebase target always yields the same key, so a lost
 * response during a rebase is also deduplicated by the server.
 */
export function rebasedOperationId(operationId: string, remoteVersion: number): string {
  return `${operationId}${REBASE_SEPARATOR}${remoteVersion}`;
}

/** True when `appliedId` (from the server history) belongs to `operationId`. */
export function belongsToOperation(appliedId: string, operationId: string): boolean {
  return appliedId === operationId || appliedId.startsWith(`${operationId}${REBASE_SEPARATOR}`);
}
