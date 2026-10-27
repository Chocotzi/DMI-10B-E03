/** @jest-environment node */
import {
  SyncPendingOperationsUseCase,
  nextSyncDelayMs,
  reviewConflict,
} from '../src/campusops/application/SyncPendingOperationsUseCase';
import type { QueuedOperation } from '../src/campusops/contracts';
import type {
  ActionOutcome,
  ActionSubmission,
  IncidentSyncGateway,
  SnapshotOutcome,
} from '../src/campusops/domain/IncidentSyncGateway';
import { createOfflineOperation, intendedFields, rebasedOperationId } from '../src/campusops/domain/OfflineSync';
import type { SyncableOperation } from '../src/campusops/domain/OfflineSync';
import { PersistentOperationQueueRepository } from '../src/campusops/infrastructure/PersistentOperationQueueRepository';
import type { KeyValueStorage } from '../src/campusops/infrastructure/PersistentOperationQueueRepository';

/**
 * Week 08 — sync policy edge cases with a deterministic gateway double: the
 * branches the didactic backend cannot produce on demand (reused key with
 * other content, unreadable 2xx, crash after a rebase, missing base…).
 */
function memoryStorage(): KeyValueStorage {
  const disk = new Map<string, string>();
  return {
    getItem: async (key) => disk.get(key) ?? null,
    setItem: async (key, value) => { disk.set(key, value); },
  };
}

function scriptedGateway(script: { submit: ActionOutcome[]; snapshots?: SnapshotOutcome[] }) {
  const submissions: ActionSubmission[] = [];
  const gateway: IncidentSyncGateway = {
    submitAction: async (submission) => {
      submissions.push(submission);
      const next = script.submit.shift();
      if (!next) throw new Error('submitAction no esperado');
      return next;
    },
    fetchSnapshot: async () => {
      const next = script.snapshots?.shift();
      if (!next) throw new Error('fetchSnapshot no esperado');
      return next;
    },
  };
  return { gateway, submissions };
}

const base = {
  version: 2,
  fields: { work: { assignedTechnicianId: 'technician-1', status: 'assigned' }, priority: 'medium' },
};

function operation(operationId: string, action = 'start', incidentId = 'campus-inc-101',
  payload: Readonly<Record<string, unknown>> = {}): SyncableOperation {
  return createOfflineOperation({
    operationId, incidentId, actorId: 'technician-1', action, payload, base, createdAt: '2026-10-25T10:00:00-06:00',
  });
}

async function queueWith(...operations: SyncableOperation[]): Promise<PersistentOperationQueueRepository> {
  const queue = new PersistentOperationQueueRepository({ storage: memoryStorage() });
  for (const item of operations) await queue.enqueue(item);
  return queue;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('Week 08 — política de sincronización: casos límite (Integrante 3)', () => {
  it('una clave reutilizada con otro contenido o una operación inválida se conservan como conflicto', async () => {
    const reused = operation('op-policy-reused-01');
    const invalid = operation('op-policy-invalid-02', 'resolve', 'campus-inc-102', { diagnosis: '' });
    const queue = await queueWith(reused, invalid);
    const { gateway } = scriptedGateway({ submit: [
      { kind: 'rejected', code: 'idempotency_key_reused', status: 409 },
      { kind: 'rejected', code: 'invalid', status: 422 },
    ] });

    const summary = await new SyncPendingOperationsUseCase({ queue, gateway }).execute();

    expect(summary.outcomes.map((item) => [item.operationId, item.result, item.reason])).toEqual([
      ['op-policy-reused-01', 'conflict', 'idempotency_key_reused'],
      ['op-policy-invalid-02', 'conflict', 'invalid_operation'],
    ]);
    expect(await queue.list()).toEqual([{ ...reused, status: 'conflict' }, { ...invalid, status: 'conflict' }]);
  });

  it('sin sesión (401) detiene el ciclo: no envía más operaciones ni las descarta', async () => {
    const first = operation('op-policy-401-01');
    const second = operation('op-policy-401-02', 'comment', 'campus-inc-103', { text: 'Nota ficticia' });
    const queue = await queueWith(first, second);
    const { gateway, submissions } = scriptedGateway({ submit: [{ kind: 'unauthenticated' }] });

    const summary = await new SyncPendingOperationsUseCase({ queue, gateway }).execute();

    expect(submissions).toHaveLength(1);
    expect(summary.outcomes.map((item) => item.reason)).toEqual(['unauthenticated', 'unauthenticated']);
    expect(summary.nextAttemptInMs).toBeNull();
    expect(await queue.list()).toEqual([first, second]);
  });

  it('una respuesta 2xx ilegible no confirma: se repite después con la misma clave y el mismo contenido', async () => {
    const pending = operation('op-policy-unreadable-01', 'comment', 'campus-inc-104', { text: 'Nota ficticia' });
    const queue = await queueWith(pending);
    const { gateway, submissions } = scriptedGateway({ submit: [
      { kind: 'unavailable', code: 'invalid_response' },
      { kind: 'applied', duplicate: true, version: 3 },
    ] });
    const useCase = new SyncPendingOperationsUseCase({ queue, gateway });

    const first = await useCase.execute();
    expect(first.outcomes[0]).toMatchObject({ result: 'pending', reason: 'invalid_response' });
    expect(await queue.list()).toEqual([pending]);

    const second = await useCase.execute({ previousFailedCycles: first.failedCycles });
    expect(second.outcomes[0]).toMatchObject({ result: 'confirmed', reason: 'replayed_duplicate' });
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[0]).toEqual({
      idempotencyKey: 'op-policy-unreadable-01', incidentId: 'campus-inc-104', action: 'comment',
      baseVersion: 2, payload: { text: 'Nota ficticia' },
    });
    expect(await queue.list()).toEqual([]);
  });

  it('si el reenvío rebasado ya se aplicó antes de un cierre, el historial del servidor lo confirma sin reenviar', async () => {
    const pending = operation('op-policy-crash-01');
    const queue = await queueWith(pending);
    const rebased = rebasedOperationId('op-policy-crash-01', 3);
    const { gateway, submissions } = scriptedGateway({
      submit: [{ kind: 'rejected', code: 'version_conflict', status: 409 }],
      snapshots: [{ kind: 'visible', snapshot: {
        id: 'campus-inc-101', version: 4,
        fields: { work: { assignedTechnicianId: 'technician-1', status: 'in_progress' }, priority: 'high' },
        appliedOperationIds: ['assign-x', 'prioritize-x', rebased],
      } }],
    });

    const summary = await new SyncPendingOperationsUseCase({ queue, gateway }).execute();

    expect(submissions).toHaveLength(1);
    expect(summary.outcomes).toEqual([{
      operationId: 'op-policy-crash-01', incidentId: 'campus-inc-101', result: 'confirmed',
      reason: 'already_applied', appliedWith: rebased,
    }]);
    expect(await queue.list()).toEqual([]);
  });

  it('una entrada sin base (migrada desde v1) no puede probar independencia: queda en conflicto', async () => {
    const withoutBase: QueuedOperation = {
      operationId: 'op-policy-nobase-01', incidentId: 'campus-inc-105', baseVersion: 1, actorId: 'technician-1',
      action: 'start', payload: {}, status: 'queued', createdAt: '2026-10-24T18:00:00-06:00',
    };
    const queue = new PersistentOperationQueueRepository({ storage: memoryStorage() });
    await queue.enqueue(withoutBase);
    const { gateway } = scriptedGateway({
      submit: [{ kind: 'rejected', code: 'version_conflict', status: 409 }],
      snapshots: [{ kind: 'visible', snapshot: {
        id: 'campus-inc-105', version: 2,
        fields: { work: { assignedTechnicianId: 'technician-1', status: 'assigned' }, priority: 'high' },
        appliedOperationIds: [],
      } }],
    });

    const summary = await new SyncPendingOperationsUseCase({ queue, gateway }).execute();

    expect(summary.outcomes[0]).toMatchObject({ result: 'conflict', reason: 'base_unknown' });
    expect(await queue.list()).toEqual([{ ...withoutBase, status: 'conflict' }]);
  });

  it('si el estado remoto ya contiene la misma intención se confirma sin reenviar; si cambia otra vez, se reintenta luego', async () => {
    const equivalent = operation('op-policy-same-01');
    const racing = operation('op-policy-race-02', 'start', 'campus-inc-106');
    const queue = await queueWith(equivalent, racing);
    const { gateway, submissions } = scriptedGateway({
      submit: [
        { kind: 'rejected', code: 'version_conflict', status: 409 },
        { kind: 'rejected', code: 'version_conflict', status: 409 },
        { kind: 'rejected', code: 'version_conflict', status: 409 },
      ],
      snapshots: [
        { kind: 'visible', snapshot: {
          id: 'campus-inc-101', version: 3,
          fields: { work: { assignedTechnicianId: 'technician-1', status: 'in_progress' }, priority: 'medium' },
          appliedOperationIds: ['other-device-start'],
        } },
        { kind: 'visible', snapshot: {
          id: 'campus-inc-106', version: 3,
          fields: { work: { assignedTechnicianId: 'technician-1', status: 'assigned' }, priority: 'low' },
          appliedOperationIds: [],
        } },
      ],
    });

    const summary = await new SyncPendingOperationsUseCase({ queue, gateway }).execute();

    expect(summary.outcomes.map((item) => [item.operationId, item.result, item.reason])).toEqual([
      ['op-policy-same-01', 'confirmed', 'already_applied'],
      ['op-policy-race-02', 'pending', 'remote_changed_again'],
    ]);
    expect(submissions.map((item) => item.idempotencyKey)).toEqual([
      'op-policy-same-01', 'op-policy-race-02', rebasedOperationId('op-policy-race-02', 3),
    ]);
    expect(await queue.list()).toEqual([racing]);
    expect(summary.nextAttemptInMs).toBe(1000);
  });

  it('el retardo entre ciclos es exponencial, acotado, respeta Retry-After y siempre es finito', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((cycles) => nextSyncDelayMs(cycles))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(nextSyncDelayMs(1, 5000)).toBe(5000);
    expect(nextSyncDelayMs(6, 1000)).toBe(30000);
    expect(nextSyncDelayMs(1, 10_000_000)).toBe(300000);
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(nextSyncDelayMs(value, value))).toBe(true);
    }
  });

  it('la revisión del conflicto y la intención local no mutan sus entradas', () => {
    const queued = deepFreeze(operation('op-policy-frozen-01'));
    const remote = deepFreeze({
      id: 'campus-inc-101', version: 3,
      fields: { work: { assignedTechnicianId: 'technician-2', status: 'assigned' }, priority: 'medium' },
      appliedOperationIds: [],
    });

    expect(reviewConflict(queued, remote)).toEqual({ kind: 'conflict', fields: ['work'] });
    expect(intendedFields(base.fields, 'start', {})).toEqual({
      work: { assignedTechnicianId: 'technician-1', status: 'in_progress' }, priority: 'medium',
    });
    expect(base.fields.work.status).toBe('assigned');
  });
});
