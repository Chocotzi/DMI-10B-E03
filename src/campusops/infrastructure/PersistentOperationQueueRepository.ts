import { deduplicateOperations } from '../../course-evaluation';
import { QueuedOperation } from '../contracts';
import { OperationQueueRepository } from '../domain/OperationQueueRepository';

/**
 * Minimal async key/value storage port. `@react-native-async-storage/async-storage`
 * already implements exactly this shape (`getItem`/`setItem`), so this
 * interface lets the repository below work against the real native module in
 * the app and against a plain in-memory fake in tests (see
 * `course-tests/week-08-offline-queue.test.ts`), without the test needing the
 * native dependency installed.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Schema version of the persisted queue; see docs/data-model.md §4. */
export const OFFLINE_QUEUE_STORAGE_KEY = 'campusops.offlineQueue.v1';

function unavailableAsyncStorage(): KeyValueStorage {
  const explain = (): never => {
    throw new Error(
      'PersistentOperationQueueRepository: "@react-native-async-storage/async-storage" no está instalado. '
        + 'Ejecuten "npm install @react-native-async-storage/async-storage" (ver docs/data-model.md §2), '
        + 'o inyecten un KeyValueStorage propio via el parámetro "storage".',
    );
  };
  return {
    getItem: () => Promise.reject(explain()),
    setItem: () => Promise.reject(explain()),
  };
}

/**
 * Lazily resolves the default storage backend. We intentionally avoid a
 * static `import` of the native package: it keeps this module (and anything
 * that only needs the in-memory test double) loadable even before the
 * dependency is installed, and it fails loudly — with an actionable message —
 * the moment someone actually tries to read or write without providing their
 * own storage.
 */
function loadDefaultStorage(): KeyValueStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require('@react-native-async-storage/async-storage') as unknown;
    const candidate = (required as { default?: unknown }).default ?? required;
    if (
      candidate
      && typeof (candidate as KeyValueStorage).getItem === 'function'
      && typeof (candidate as KeyValueStorage).setItem === 'function'
    ) {
      return candidate as KeyValueStorage;
    }
  } catch {
    // Module not installed yet in this checkout; fall through to the
    // explicit-error storage below instead of crashing at import time.
  }
  return unavailableAsyncStorage();
}

/**
 * Offline operation queue backed by a persistent key/value store.
 *
 * Survives app restarts because every mutation is written through to
 * `storage` immediately; nothing lives only in process memory. See
 * docs/data-model.md for the full entity/queue design and
 * docs/sync-policy.md for when an operation is confirmed vs. conflicting.
 */
export class PersistentOperationQueueRepository implements OperationQueueRepository {
  private readonly storage: KeyValueStorage;
  private readonly storageKey: string;

  constructor(options?: Readonly<{ storage?: KeyValueStorage; storageKey?: string }>) {
    this.storage = options?.storage ?? loadDefaultStorage();
    this.storageKey = options?.storageKey ?? OFFLINE_QUEUE_STORAGE_KEY;
  }

  private async readAll(): Promise<QueuedOperation[]> {
    const raw = await this.storage.getItem(this.storageKey);
    if (raw === null || raw === '') {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? (parsed as QueuedOperation[]) : [];
  }

  private async writeAll(operations: readonly QueuedOperation[]): Promise<void> {
    await this.storage.setItem(this.storageKey, JSON.stringify(operations));
  }

  async enqueue(operation: QueuedOperation): Promise<void> {
    const current = await this.readAll();
    const deduplicated = deduplicateOperations([...current, operation]);
    await this.writeAll(deduplicated);
  }

  async list(): Promise<readonly QueuedOperation[]> {
    return this.readAll();
  }

  async markConfirmed(operationId: string): Promise<void> {
    const current = await this.readAll();
    await this.writeAll(current.filter((op) => op.operationId !== operationId));
  }

  async markConflict(operationId: string): Promise<void> {
    const current = await this.readAll();
    const next = current.map((op) => (
      op.operationId === operationId ? { ...op, status: 'conflict' as const } : op
    ));
    await this.writeAll(next);
  }
}
