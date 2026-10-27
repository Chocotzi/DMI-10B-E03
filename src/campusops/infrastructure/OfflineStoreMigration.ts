import { deduplicateOperations } from '../../course-evaluation';
import type { QueuedOperationStatus } from '../contracts';
import type { Incident } from '../domain/Incident';
import { isSyncBase } from '../domain/OfflineSync';
import type { SyncableOperation, SyncBase } from '../domain/OfflineSync';
import {
  OFFLINE_QUEUE_STORAGE_KEY,
  PersistentOperationQueueRepository,
} from './PersistentOperationQueueRepository';
import type { KeyValueStorage } from './PersistentOperationQueueRepository';

/**
 * Week 08 — schema migration of the offline store, v1 → v2.
 *
 * AsyncStorage has no multi-key transactions, so the migration is made atomic
 * with shadow keys plus a single commit point (docs/data-model.md §4):
 *
 *   1. v2 is written under NEW keys; v1 keys are never modified before commit.
 *   2. Every v2 key is read back and compared with what was written.
 *   3. Commit = one single-key write: `campusops.schemaVersion = "2"`.
 *   4. Only after the commit are the v1 keys removed.
 *
 * Readers choose keys by the schema pointer, so an uncommitted v2 key is never
 * read. A failure before the commit removes the shadow keys (rollback); if the
 * process dies before it can roll back, the next start removes them before
 * migrating again (recovery). The store is never left half v1 / half v2.
 */

/** Async storage able to delete keys (AsyncStorage implements it). */
export interface MigratableStorage extends KeyValueStorage {
  removeItem(key: string): Promise<void>;
}

export const OFFLINE_SCHEMA_VERSION_KEY = 'campusops.schemaVersion';
export const OFFLINE_QUEUE_V1_KEY = OFFLINE_QUEUE_STORAGE_KEY;
export const OFFLINE_INCIDENTS_V1_KEY = 'campusops.incidents.v1';
export const OFFLINE_QUEUE_V2_KEY = 'campusops.offlineQueue.v2';
export const OFFLINE_INCIDENTS_V2_KEY = 'campusops.incidents.v2';
export const CURRENT_OFFLINE_SCHEMA_VERSION = 2;

const LEGACY_KEYS = [OFFLINE_QUEUE_V1_KEY, OFFLINE_INCIDENTS_V1_KEY] as const;
const SHADOW_KEYS = [OFFLINE_QUEUE_V2_KEY, OFFLINE_INCIDENTS_V2_KEY] as const;
const COMMITTED = String(CURRENT_OFFLINE_SCHEMA_VERSION);

/** v2 incident cache: snapshots indexed by incident id. */
export type IncidentCacheV2 = Readonly<Record<string, Incident>>;

export type MigrationStep =
  | 'read_schema_version'
  | 'recover_leftovers'
  | 'read_v1'
  | 'validate_v1'
  | 'write_queue_v2'
  | 'write_incidents_v2'
  | 'verify_v2'
  | 'commit';

export type MigrationReport =
  | Readonly<{ status: 'fresh_install'; schemaVersion: 2 }>
  | Readonly<{
      status: 'already_current';
      schemaVersion: 2;
      cleanedLegacyKeys: readonly string[];
      legacyCleanupPending: boolean;
    }>
  | Readonly<{
      status: 'migrated';
      schemaVersion: 2;
      fromVersion: 1;
      operations: number;
      incidents: number;
      basesDerived: number;
      duplicatesCollapsed: number;
      recoveredLeftovers: readonly string[];
      legacyCleanupPending: boolean;
      commitConfirmedAfterError: boolean;
    }>
  /** v1 is intact and still the active schema; the migration is retried on the next start. */
  | Readonly<{
      status: 'rolled_back';
      schemaVersion: 1;
      failedStep: MigrationStep;
      reason: string;
      rollbackComplete: boolean;
      recoveredLeftovers: readonly string[];
    }>
  /** The active schema cannot be used safely (unreadable data or unknown state); nothing was changed. */
  | Readonly<{
      status: 'blocked';
      schemaVersion: number | null;
      failedStep: MigrationStep;
      reason: string;
    }>;

const OPERATION_STATUSES: readonly QueuedOperationStatus[] = ['queued', 'confirmed', 'conflict'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQueuedOperationV1(value: unknown): value is SyncableOperation {
  return isRecord(value)
    && nonempty(value.operationId)
    && nonempty(value.incidentId)
    && nonempty(value.actorId)
    && nonempty(value.action)
    && Number.isSafeInteger(value.baseVersion)
    && (value.baseVersion as number) >= 0
    && isRecord(value.payload)
    && OPERATION_STATUSES.includes(value.status as QueuedOperationStatus)
    && typeof value.createdAt === 'string';
}

function isCachedIncidentV1(value: unknown): value is Incident {
  return isRecord(value)
    && nonempty(value.id)
    && Number.isSafeInteger(value.version)
    && (value.version as number) >= 0
    && isRecord(value.work)
    && nonempty(value.work.status)
    && (value.work.assignedTechnicianId === null || nonempty(value.work.assignedTechnicianId));
}

type ParsedArray<T> = Readonly<{ ok: true; value: T[] }> | Readonly<{ ok: false; reason: string }>;

function parseV1Array<T>(raw: string | null, guard: (value: unknown) => value is T, key: string): ParsedArray<T> {
  if (raw === null || raw === '') return { ok: true, value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${key}: JSON ilegible` };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: `${key}: se esperaba un arreglo` };
  const invalidIndex = parsed.findIndex((item) => !guard(item));
  if (invalidIndex >= 0) return { ok: false, reason: `${key}: el registro ${invalidIndex} no cumple el esquema v1` };
  return { ok: true, value: parsed as T[] };
}

type StoreV2 = Readonly<{
  operations: readonly SyncableOperation[];
  incidents: IncidentCacheV2;
  basesDerived: number;
  duplicatesCollapsed: number;
}>;

/** Pure v1 → v2 transformation; it never mutates its inputs. */
export function transformV1ToV2(
  queue: readonly SyncableOperation[],
  incidents: readonly Incident[],
): StoreV2 {
  const cache: Record<string, Incident> = {};
  for (const incident of incidents) {
    const previous = cache[incident.id];
    if (!previous || incident.version > previous.version) cache[incident.id] = incident;
  }
  const unique = deduplicateOperations(queue);
  let basesDerived = 0;
  const operations = unique.map((operation): SyncableOperation => {
    if (isSyncBase(operation.base) && operation.base.version === operation.baseVersion) return operation;
    const cached = cache[operation.incidentId];
    const base: SyncBase | null = cached && cached.version === operation.baseVersion
      ? { version: cached.version, fields: { work: { ...cached.work } } }
      : null;
    if (base) basesDerived += 1;
    return { ...operation, base };
  });
  return { operations, incidents: cache, basesDerived, duplicatesCollapsed: queue.length - unique.length };
}

/** Removes the given keys that exist; throws if the storage fails. */
async function removeExistingKeys(storage: MigratableStorage, keys: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const key of keys) {
    if (await storage.getItem(key) !== null) {
      await storage.removeItem(key);
      removed.push(key);
    }
  }
  return removed;
}

type RollbackResult = 'complete' | 'incomplete' | 'already_committed' | 'commit_unknown';

async function rollbackShadowKeys(storage: MigratableStorage, commitAttempted: boolean): Promise<RollbackResult> {
  if (commitAttempted) {
    let pointer: string | null;
    try {
      pointer = await storage.getItem(OFFLINE_SCHEMA_VERSION_KEY);
    } catch {
      return 'commit_unknown';
    }
    // The commit write may land even when it reports an error: then v2 is authoritative.
    if (pointer === COMMITTED) return 'already_committed';
  }
  try {
    await removeExistingKeys(storage, SHADOW_KEYS);
    return 'complete';
  } catch {
    return 'incomplete';
  }
}

async function finishCommitted(
  storage: MigratableStorage,
  store: StoreV2,
  recoveredLeftovers: readonly string[],
  commitConfirmedAfterError: boolean,
): Promise<MigrationReport> {
  let legacyCleanupPending = false;
  try {
    await removeExistingKeys(storage, LEGACY_KEYS);
  } catch {
    // Harmless: the pointer already says v2, so v1 is ignored and removed on the next start.
    legacyCleanupPending = true;
  }
  return {
    status: 'migrated',
    schemaVersion: 2,
    fromVersion: 1,
    operations: store.operations.length,
    incidents: Object.keys(store.incidents).length,
    basesDerived: store.basesDerived,
    duplicatesCollapsed: store.duplicatesCollapsed,
    recoveredLeftovers,
    legacyCleanupPending,
    commitConfirmedAfterError,
  };
}

/**
 * Brings the offline store to schema v2. Safe to call on every app start:
 * it is idempotent and it recovers from a previously interrupted run.
 */
export async function migrateOfflineStore(storage: MigratableStorage): Promise<MigrationReport> {
  let step: MigrationStep = 'read_schema_version';
  let pointer: string | null;
  try {
    pointer = await storage.getItem(OFFLINE_SCHEMA_VERSION_KEY);
  } catch (error) {
    return { status: 'blocked', schemaVersion: null, failedStep: step, reason: describe(error) };
  }

  if (pointer === COMMITTED) {
    try {
      const cleaned = await removeExistingKeys(storage, LEGACY_KEYS);
      return { status: 'already_current', schemaVersion: 2, cleanedLegacyKeys: cleaned, legacyCleanupPending: false };
    } catch {
      return { status: 'already_current', schemaVersion: 2, cleanedLegacyKeys: [], legacyCleanupPending: true };
    }
  }
  if (pointer !== null && pointer !== '1') {
    const found = Number(pointer);
    return {
      status: 'blocked',
      schemaVersion: Number.isSafeInteger(found) ? found : null,
      failedStep: step,
      reason: `versión de esquema desconocida: ${pointer}`,
    };
  }

  step = 'recover_leftovers';
  let recoveredLeftovers: string[];
  try {
    recoveredLeftovers = await removeExistingKeys(storage, SHADOW_KEYS);
  } catch (error) {
    return {
      status: 'rolled_back', schemaVersion: 1, failedStep: step, reason: describe(error),
      rollbackComplete: false, recoveredLeftovers: [],
    };
  }

  step = 'read_v1';
  let rawQueue: string | null;
  let rawIncidents: string | null;
  try {
    rawQueue = await storage.getItem(OFFLINE_QUEUE_V1_KEY);
    rawIncidents = await storage.getItem(OFFLINE_INCIDENTS_V1_KEY);
  } catch (error) {
    return {
      status: 'rolled_back', schemaVersion: 1, failedStep: step, reason: describe(error),
      rollbackComplete: true, recoveredLeftovers,
    };
  }

  if (pointer === null && rawQueue === null && rawIncidents === null) {
    step = 'commit';
    try {
      await storage.setItem(OFFLINE_SCHEMA_VERSION_KEY, COMMITTED);
    } catch (error) {
      return {
        status: 'rolled_back', schemaVersion: 1, failedStep: step, reason: describe(error),
        rollbackComplete: true, recoveredLeftovers,
      };
    }
    return { status: 'fresh_install', schemaVersion: 2 };
  }

  step = 'validate_v1';
  const queue = parseV1Array(rawQueue, isQueuedOperationV1, OFFLINE_QUEUE_V1_KEY);
  const incidents = parseV1Array(rawIncidents, isCachedIncidentV1, OFFLINE_INCIDENTS_V1_KEY);
  if (!queue.ok || !incidents.ok) {
    const reasons = [queue, incidents].flatMap((item) => (item.ok ? [] : [item.reason]));
    return { status: 'blocked', schemaVersion: 1, failedStep: step, reason: reasons.join('; ') };
  }

  const store = transformV1ToV2(queue.value, incidents.value);
  const queueJson = JSON.stringify(store.operations);
  const incidentsJson = JSON.stringify(store.incidents);

  try {
    step = 'write_queue_v2';
    await storage.setItem(OFFLINE_QUEUE_V2_KEY, queueJson);
    step = 'write_incidents_v2';
    await storage.setItem(OFFLINE_INCIDENTS_V2_KEY, incidentsJson);
    step = 'verify_v2';
    const writtenQueue = await storage.getItem(OFFLINE_QUEUE_V2_KEY);
    const writtenIncidents = await storage.getItem(OFFLINE_INCIDENTS_V2_KEY);
    if (writtenQueue !== queueJson || writtenIncidents !== incidentsJson) {
      throw new Error('la relectura de v2 no coincide con lo escrito');
    }
    step = 'commit';
    await storage.setItem(OFFLINE_SCHEMA_VERSION_KEY, COMMITTED);
  } catch (error) {
    const rollback = await rollbackShadowKeys(storage, step === 'commit');
    if (rollback === 'already_committed') return finishCommitted(storage, store, recoveredLeftovers, true);
    if (rollback === 'commit_unknown') {
      return {
        status: 'blocked', schemaVersion: null, failedStep: step,
        reason: `${describe(error)}; no se pudo comprobar si el commit llegó`,
      };
    }
    return {
      status: 'rolled_back', schemaVersion: 1, failedStep: step, reason: describe(error),
      rollbackComplete: rollback === 'complete', recoveredLeftovers,
    };
  }
  return finishCommitted(storage, store, recoveredLeftovers, false);
}

export class OfflineStoreUnavailableError extends Error {
  constructor(readonly migration: MigrationReport) {
    super(`El almacenamiento sin conexión no puede abrirse con seguridad (${migration.status}); no se modificó ningún dato.`);
    this.name = 'OfflineStoreUnavailableError';
  }
}

export type OfflineStoreHandle = Readonly<{
  schemaVersion: 1 | 2;
  queueStorageKey: string;
  queue: PersistentOperationQueueRepository;
  migration: MigrationReport;
}>;

function isMigratableStorage(value: unknown): value is MigratableStorage {
  return typeof value === 'object' && value !== null
    && typeof (value as MigratableStorage).getItem === 'function'
    && typeof (value as MigratableStorage).setItem === 'function'
    && typeof (value as MigratableStorage).removeItem === 'function';
}

function loadDeviceStorage(): MigratableStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require('@react-native-async-storage/async-storage') as unknown;
    const candidate = (required as { default?: unknown }).default ?? required;
    if (isMigratableStorage(candidate)) return candidate;
  } catch {
    // Native module unavailable (e.g. Jest without a device); fail explicitly below.
  }
  throw new Error(
    'openOfflineStore: @react-native-async-storage/async-storage no está disponible; inyecten un MigratableStorage.',
  );
}

/**
 * Composition entry point for the offline store: runs the migration and
 * returns the queue bound to the active schema. After a rollback the app keeps
 * working on the intact v1 data; when the state cannot be used safely it
 * throws instead of handing out a queue that could overwrite data.
 */
export async function openOfflineStore(storage?: MigratableStorage): Promise<OfflineStoreHandle> {
  const resolved = storage ?? loadDeviceStorage();
  const migration = await migrateOfflineStore(resolved);
  if (migration.status === 'blocked') throw new OfflineStoreUnavailableError(migration);
  const schemaVersion = migration.schemaVersion;
  const queueStorageKey = schemaVersion === 2 ? OFFLINE_QUEUE_V2_KEY : OFFLINE_QUEUE_V1_KEY;
  return {
    schemaVersion,
    queueStorageKey,
    queue: new PersistentOperationQueueRepository({ storage: resolved, storageKey: queueStorageKey }),
    migration,
  };
}
