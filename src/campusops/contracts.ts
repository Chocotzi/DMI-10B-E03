/** Public domain vocabulary; teams choose their internal architecture. */
export type CampusRole = 'reporter' | 'technician' | 'coordinator';
export type IncidentStatus = 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed';
export type IncidentCategory =
  | 'electrical' | 'laboratory' | 'water' | 'connectivity'
  | 'equipment' | 'safety' | 'maintenance';

export type IncidentWork = Readonly<{
  assignedTechnicianId: string | null;
  status: IncidentStatus;
}>;

export type IncidentLocation = Readonly<{
  source: 'provider' | 'manual';
  label: string;
  latitude?: number;
  longitude?: number;
}>;

export type PendingIncidentOperation = Readonly<{
  operationId: string;
  incidentId: string;
  baseVersion: number;
  actorId: string;
  action: string;
  payload: Readonly<Record<string, unknown>>;
}>;

/**
 * Week 08 — offline operation queue.
 *
 * A `QueuedOperation` is a `PendingIncidentOperation` plus the local lifecycle
 * fields the device needs to persist the queue across restarts and to decide
 * when it is safe to evict an entry. `status` and `createdAt` never travel to
 * the backend; they are local-only bookkeeping (see docs/data-model.md §1-3).
 */
export type QueuedOperationStatus = 'queued' | 'confirmed' | 'conflict';

export type QueuedOperation = PendingIncidentOperation & Readonly<{
  status: QueuedOperationStatus;
  /** ISO-8601 timestamp of when the operation was first enqueued locally. */
  createdAt: string;
}>;
