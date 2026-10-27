import { QueuedOperation } from '../contracts';

/**
 * Port for the offline operation queue (Week 08).
 *
 * Implementations MUST survive an app restart (see
 * `PersistentOperationQueueRepository`) and MUST NOT provide any way to
 * discard the whole queue. The only legitimate way to remove an entry is
 * `markConfirmed`, once the backend has applied its effect exactly once.
 */
export interface OperationQueueRepository {
  /**
   * Adds a pending operation to the queue. Enqueuing the same `operationId`
   * again before it is confirmed must not create a duplicate entry (see
   * `deduplicateOperations` in `src/course-evaluation/index.ts`).
   */
  enqueue(operation: QueuedOperation): Promise<void>;

  /** Returns every operation currently in the queue, in insertion order. */
  list(): Promise<readonly QueuedOperation[]>;

  /**
   * Retires an operation from the queue. Call this only after the backend
   * confirmed the operation's effect was applied exactly once. This is the
   * ONLY method in this port that removes an entry.
   */
  markConfirmed(operationId: string): Promise<void>;

  /**
   * Marks an operation as conflicting with the remote state (e.g. a
   * reassignment detected by `resolveSync`). The operation stays in the
   * queue — a conflict never causes data loss — so a person can resolve it
   * later.
   */
  markConflict(operationId: string): Promise<void>;
}
