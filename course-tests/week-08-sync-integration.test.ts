/** @jest-environment node */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { SyncPendingOperationsUseCase, reviewConflict } from '../src/campusops/application/SyncPendingOperationsUseCase';
import type { RemoteIncidentSnapshot } from '../src/campusops/domain/IncidentSyncGateway';
import { createOfflineOperation } from '../src/campusops/domain/OfflineSync';
import type { SyncBase, SyncableOperation } from '../src/campusops/domain/OfflineSync';
import { HttpIncidentSyncGateway } from '../src/campusops/infrastructure/HttpIncidentSyncGateway';
import type { SyncGatewayOptions } from '../src/campusops/infrastructure/HttpIncidentSyncGateway';
import {
  OFFLINE_INCIDENTS_V1_KEY,
  OFFLINE_QUEUE_V1_KEY,
  openOfflineStore,
} from '../src/campusops/infrastructure/OfflineStoreMigration';
import type { MigratableStorage } from '../src/campusops/infrastructure/OfflineStoreMigration';

/**
 * Week 08 — full synchronization against the didactic backend (no public
 * Internet). Every case persists the queue on a fake device disk, "restarts"
 * the app (new store over the same disk) and only then reconnects.
 * With WEEK08_TRACE_DIR set the observed states go to
 * <dir>/generated-sync-trace.json (ignored by Git).
 */
let backend: ChildProcessWithoutNullStreams;
let baseUrl = '';

beforeAll(async () => {
  backend = spawn(process.execPath, ['course-backend/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('backend startup timeout')), 5000);
    backend.stdout.once('data', (chunk: Buffer) => {
      clearTimeout(deadline);
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
      else reject(new Error('backend did not publish a port'));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`backend exited: ${code}`)));
  });
}, 10000);

const trace: Record<string, unknown> = {};

afterAll(() => {
  backend?.kill();
  const directory = process.env.WEEK08_TRACE_DIR;
  if (directory) {
    writeFileSync(
      join(directory, 'generated-sync-trace.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: trace }, null, 2)}\n`,
      'utf8',
    );
  }
});

/** fetch over node:http (same approach as the week 05 integration test), with headers and abort. */
const localFetch = ((input: string, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
  const connection = request(input, {
    method: init?.method ?? 'GET',
    headers: init?.headers as Record<string, string>,
    signal: init?.signal ?? undefined,
  }, (reply) => {
    const chunks: Buffer[] = [];
    reply.on('data', (chunk: Buffer) => chunks.push(chunk));
    reply.on('end', () => {
      const status = reply.statusCode ?? 0;
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => {
          const value = reply.headers[name.toLowerCase()];
          return typeof value === 'string' ? value : null;
        } },
        json: async () => JSON.parse(text) as unknown,
      } as unknown as Response);
    });
    reply.on('error', reject);
  });
  connection.on('error', reject);
  connection.end(init?.body as string | undefined);
})) as typeof fetch;

type CallResult = Readonly<{ status: number; body: Record<string, unknown> }>;

/** Direct call used only to prepare the scenario (reporter/coordinator actions). */
async function call(actorId: string, path: string, body?: object, key?: string): Promise<CallResult> {
  const response = await localFetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer course-valid-token',
      'X-Course-Actor': actorId,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function gateway(actorId: string, extra: Omit<SyncGatewayOptions, 'baseUrl' | 'actorId' | 'accessToken' | 'fetchImpl'> = {}) {
  return new HttpIncidentSyncGateway({
    baseUrl, actorId, accessToken: 'course-valid-token', fetchImpl: localFetch, ...extra,
  });
}

async function snapshotAs(actorId: string, incidentId: string): Promise<RemoteIncidentSnapshot> {
  const outcome = await gateway(actorId).fetchSnapshot(incidentId);
  if (outcome.kind !== 'visible') throw new Error(`${actorId} cannot see ${incidentId}: ${outcome.kind}`);
  return outcome.snapshot;
}

/** reporter-1 creates a synthetic incident and coordinator-1 assigns technician-1 (version 2). */
async function incidentAssignedToTechnician1(label: string): Promise<string> {
  const created = await call('reporter-1', '/v1/incidents', {
    category: 'connectivity', description: `Incidencia ficticia ${label}`, location: 'Edificio de prueba A',
  }, `create-${label}`);
  expect(created.status).toBe(201);
  const id = (created.body.incident as { id: string }).id;
  const assigned = await call('coordinator-1', `/v1/incidents/${id}/actions`, {
    action: 'assign', baseVersion: 1, technicianId: 'technician-1',
  }, `assign-${label}`);
  expect(assigned.status).toBe(201);
  return id;
}

function deviceDisk(entries: readonly (readonly [string, string])[] = []): MigratableStorage & {
  keys(): string[];
  dump(): string;
} {
  const disk = new Map<string, string>(entries);
  return {
    getItem: async (key) => disk.get(key) ?? null,
    setItem: async (key, value) => { disk.set(key, value); },
    removeItem: async (key) => { disk.delete(key); },
    keys: () => [...disk.keys()].sort(),
    dump: () => JSON.stringify([...disk.entries()]),
  };
}

const createdAt = '2026-10-25T10:00:00-06:00';

function offlineOperation(operationId: string, incidentId: string, action: string, base: SyncBase,
  payload: Readonly<Record<string, unknown>> = {}): SyncableOperation {
  return createOfflineOperation({ operationId, incidentId, actorId: 'technician-1', action, payload, base, createdAt });
}

function summarizeRemote(snapshot: RemoteIncidentSnapshot): Record<string, unknown> {
  return { version: snapshot.version, fields: snapshot.fields, history: snapshot.appliedOperationIds };
}

describe('Week 08 — sincronización real con el backend didáctico (Integrante 3)', () => {
  it('reasignación concurrente: declara el conflicto y conserva la intención local y la asignación remota', async () => {
    const id = await incidentAssignedToTechnician1('reasignacion');
    const seen = await snapshotAs('technician-1', id);
    const base = { version: seen.version, fields: seen.fields };
    const disk = deviceDisk();

    // Sin conexión: inicio de atención, nota y referencia de foto pendiente.
    const offline = await openOfflineStore(disk);
    const pending = [
      offlineOperation('op-reasig-start-01', id, 'start', base),
      offlineOperation('op-reasig-note-02', id, 'comment', base, { text: 'Nota ficticia escrita sin conexión' }),
      offlineOperation('op-reasig-photo-03', id, 'add_evidence', base, { evidenceId: 'evidence-ref-pending-01' }),
    ];
    for (const operation of pending) await offline.queue.enqueue(operation);

    // Mientras tanto coordinación reasigna en el servidor.
    const reassigned = await call('coordinator-1', `/v1/incidents/${id}/actions`, {
      action: 'assign', baseVersion: seen.version, technicianId: 'technician-2',
    }, `reassign-${id}`);
    expect(reassigned.status).toBe(201);

    // Reinicio de la app y reconexión.
    const restarted = await openOfflineStore(disk);
    expect(await restarted.queue.list()).toEqual(pending);
    const summary = await new SyncPendingOperationsUseCase({ queue: restarted.queue, gateway: gateway('technician-1') }).execute();

    expect(summary.outcomes).toEqual([
      { operationId: 'op-reasig-start-01', incidentId: id, result: 'conflict', reason: 'forbidden' },
      { operationId: 'op-reasig-note-02', incidentId: id, result: 'pending', reason: 'blocked_by_previous_operation' },
      { operationId: 'op-reasig-photo-03', incidentId: id, result: 'pending', reason: 'blocked_by_previous_operation' },
    ]);
    expect(summary.nextAttemptInMs).toBeNull();

    // La intención local sigue en la cola tras otro reinicio: sólo cambia su estado.
    const queueAfter = await (await openOfflineStore(disk)).queue.list();
    expect(queueAfter).toEqual([{ ...pending[0], status: 'conflict' }, pending[1], pending[2]]);
    // Lo persistido no incluye credenciales: la sesión sigue sólo en memoria (semanas 4 y 6).
    expect(disk.dump()).not.toMatch(/course-valid-token|Bearer|accessToken|refreshToken/);

    // La asignación remota no se sobrescribió y no se aplicó ningún efecto antiguo.
    const remote = await snapshotAs('coordinator-1', id);
    expect(remote.version).toBe(seen.version + 1);
    expect(remote.fields.work).toEqual({ assignedTechnicianId: 'technician-2', status: 'assigned' });
    expect(remote.appliedOperationIds.some((key) => key.startsWith('op-reasig-'))).toBe(false);

    // Lo que coordinación ve al revisar el conflicto: resolveSync sobre datos reales, sin mutarlos.
    const conflicted = queueAfter[0] as SyncableOperation;
    const frozen = JSON.stringify([conflicted, remote]);
    const review = reviewConflict(conflicted, remote);
    expect(review).toEqual({ kind: 'conflict', fields: ['work'] });
    expect(JSON.stringify([conflicted, remote])).toBe(frozen);

    // Repetir la sincronización no reenvía ni descarta nada.
    const again = await new SyncPendingOperationsUseCase({ queue: restarted.queue, gateway: gateway('technician-1') }).execute();
    expect(again.outcomes.map((item) => item.reason)).toEqual([
      'awaiting_resolution', 'blocked_by_previous_operation', 'blocked_by_previous_operation',
    ]);
    expect(await restarted.queue.list()).toHaveLength(3);
    expect((await snapshotAs('coordinator-1', id)).version).toBe(remote.version);

    trace['conflicto-reasignacion'] = {
      queueBeforeSync: pending.map((item) => `${item.operationId}:${item.status}`),
      outcomes: summary.outcomes,
      queueAfterSync: queueAfter.map((item) => `${item.operationId}:${item.status}`),
      persistedKeys: disk.keys(),
      persistedCredentials: /course-valid-token|Bearer|accessToken|refreshToken/.test(disk.dump()),
      remoteAfterSync: summarizeRemote(remote),
      coordinatorReview: review,
      secondRun: again.outcomes.map((item) => item.reason),
    };
  });

  it('cambios independientes: combina la prioridad remota con el inicio local sin mutar las entradas', async () => {
    const id = await incidentAssignedToTechnician1('combinacion');
    const seen = await snapshotAs('technician-1', id);
    const disk = deviceDisk();
    const operation = offlineOperation('op-merge-start-01', id, 'start', { version: seen.version, fields: seen.fields });
    await (await openOfflineStore(disk)).queue.enqueue(operation);

    const prioritized = await call('coordinator-1', `/v1/incidents/${id}/actions`, {
      action: 'prioritize', baseVersion: seen.version, priority: 'high',
    }, `prioritize-${id}`);
    expect(prioritized.status).toBe(201);

    const restarted = await openOfflineStore(disk);
    const summary = await new SyncPendingOperationsUseCase({ queue: restarted.queue, gateway: gateway('technician-1') }).execute();

    const rebasedKey = `op-merge-start-01:rebase:v${seen.version + 1}`;
    expect(summary.outcomes).toEqual([{
      operationId: 'op-merge-start-01', incidentId: id, result: 'confirmed', reason: 'rebased_independent_changes',
      appliedWith: rebasedKey,
      mergedFields: { work: { assignedTechnicianId: 'technician-1', status: 'in_progress' }, priority: 'high' },
    }]);
    expect(await restarted.queue.list()).toEqual([]);

    const remote = await snapshotAs('coordinator-1', id);
    expect(remote.fields).toEqual({ work: { assignedTechnicianId: 'technician-1', status: 'in_progress' }, priority: 'high' });
    expect(remote.version).toBe(seen.version + 2);
    expect(remote.appliedOperationIds.filter((key) => key.startsWith('op-merge-start-01'))).toEqual([rebasedKey]);

    trace['combinacion-cambios-independientes'] = {
      base: { version: seen.version, fields: seen.fields },
      outcomes: summary.outcomes,
      remoteAfterSync: summarizeRemote(remote),
    };
  });

  it('respuesta perdida: lo no confirmado queda pendiente y el reintento con la misma identidad no duplica el efecto', async () => {
    const id = await incidentAssignedToTechnician1('respuesta-perdida');
    const seen = await snapshotAs('technician-1', id);
    const disk = deviceDisk();
    const operation = offlineOperation('op-lost-start-01', id, 'start', { version: seen.version, fields: seen.fields });
    await (await openOfflineStore(disk)).queue.enqueue(operation);

    // El servidor guarda el cambio pero el cliente aborta por su propio timeout.
    const lost = await new SyncPendingOperationsUseCase({
      queue: (await openOfflineStore(disk)).queue,
      gateway: gateway('technician-1', { scenario: 'timeout_after_commit', timeoutMs: 500 }),
    }).execute();
    expect(lost.outcomes).toEqual([{ operationId: 'op-lost-start-01', incidentId: id, result: 'pending', reason: 'timeout' }]);
    expect(lost.failedCycles).toBe(1);
    expect(lost.nextAttemptInMs).toBe(1000);
    const queueAfterTimeout = await (await openOfflineStore(disk)).queue.list();
    expect(queueAfterTimeout).toEqual([operation]);
    const remoteAfterTimeout = await snapshotAs('coordinator-1', id);
    expect(remoteAfterTimeout.appliedOperationIds.filter((key) => key === 'op-lost-start-01')).toHaveLength(1);

    // Reinicio + reconexión: se repite exactamente la misma operación.
    const replay = await new SyncPendingOperationsUseCase({
      queue: (await openOfflineStore(disk)).queue,
      gateway: gateway('technician-1'),
    }).execute({ previousFailedCycles: lost.failedCycles });
    expect(replay.outcomes).toEqual([{
      operationId: 'op-lost-start-01', incidentId: id, result: 'confirmed', reason: 'replayed_duplicate',
      appliedWith: 'op-lost-start-01',
    }]);
    expect(replay.failedCycles).toBe(0);
    expect(replay.nextAttemptInMs).toBeNull();
    expect(await (await openOfflineStore(disk)).queue.list()).toEqual([]);

    const remote = await snapshotAs('coordinator-1', id);
    expect(remote.version).toBe(remoteAfterTimeout.version);
    expect(remote.appliedOperationIds.filter((key) => key === 'op-lost-start-01')).toHaveLength(1);
    expect(remote.fields.work).toEqual({ assignedTechnicianId: 'technician-1', status: 'in_progress' });

    trace['operacion-repetida-respuesta-perdida'] = {
      firstRun: lost.outcomes,
      queueAfterTimeout: queueAfterTimeout.map((item) => `${item.operationId}:${item.status}`),
      remoteAfterTimeout: summarizeRemote(remoteAfterTimeout),
      replay: replay.outcomes,
      remoteAfterReplay: summarizeRemote(remote),
    };
  }, 10000);

  it('error del servidor y 429: la operación sigue en la cola con su identidad hasta que se confirma', async () => {
    const id = await incidentAssignedToTechnician1('sin-confirmacion');
    const seen = await snapshotAs('technician-1', id);
    const disk = deviceDisk();
    const operation = offlineOperation('op-unconfirmed-note-01', id, 'comment', { version: seen.version, fields: seen.fields }, {
      text: 'Nota ficticia pendiente de confirmar',
    });
    await (await openOfflineStore(disk)).queue.enqueue(operation);
    const sync = async (scenario: SyncGatewayOptions['scenario'], previousFailedCycles: number) => (
      new SyncPendingOperationsUseCase({
        queue: (await openOfflineStore(disk)).queue,
        gateway: gateway('technician-1', scenario ? { scenario } : {}),
      }).execute({ previousFailedCycles })
    );

    const serverError = await sync('server_error', 0);
    expect(serverError.outcomes).toEqual([{ operationId: 'op-unconfirmed-note-01', incidentId: id, result: 'pending', reason: 'server' }]);
    expect(serverError.nextAttemptInMs).toBe(1000);

    const rateLimited = await sync('rate_limited', serverError.failedCycles);
    expect(rateLimited.outcomes).toEqual([{
      operationId: 'op-unconfirmed-note-01', incidentId: id, result: 'pending', reason: 'rate_limited', retryAfterMs: 1000,
    }]);
    expect(rateLimited.failedCycles).toBe(2);
    expect(rateLimited.nextAttemptInMs).toBe(2000);

    const queueWhileFailing = await (await openOfflineStore(disk)).queue.list();
    expect(queueWhileFailing).toEqual([operation]);
    const remoteWhileFailing = await snapshotAs('coordinator-1', id);
    expect(remoteWhileFailing.version).toBe(seen.version);

    const recovered = await sync(undefined, rateLimited.failedCycles);
    expect(recovered.outcomes).toEqual([{
      operationId: 'op-unconfirmed-note-01', incidentId: id, result: 'confirmed', reason: 'applied',
      appliedWith: 'op-unconfirmed-note-01',
    }]);
    expect(await (await openOfflineStore(disk)).queue.list()).toEqual([]);
    const remote = await snapshotAs('coordinator-1', id);
    expect(remote.version).toBe(seen.version + 1);
    expect(remote.appliedOperationIds.filter((key) => key === 'op-unconfirmed-note-01')).toHaveLength(1);

    trace['operacion-sin-confirmacion'] = {
      serverError: { outcomes: serverError.outcomes, nextAttemptInMs: serverError.nextAttemptInMs },
      rateLimited: { outcomes: rateLimited.outcomes, nextAttemptInMs: rateLimited.nextAttemptInMs },
      queueWhileFailing: queueWhileFailing.map((item) => `${item.operationId}:${item.status}`),
      remoteVersionWhileFailing: remoteWhileFailing.version,
      recovered: recovered.outcomes,
      remoteAfterRecovery: summarizeRemote(remote),
    };
  });

  it('la cola migrada desde v1 conserva su identidad y se sincroniza', async () => {
    const id = await incidentAssignedToTechnician1('migrada');
    const seen = await snapshotAs('technician-1', id);
    const legacyOperation = {
      operationId: 'op-v1-legacy-note-01', incidentId: id, baseVersion: seen.version, actorId: 'technician-1',
      action: 'comment', payload: { text: 'Nota guardada con el esquema v1' }, status: 'queued', createdAt,
    };
    const legacyIncident = {
      id, version: seen.version, title: 'Incidencia ficticia migrada', description: 'Incidencia ficticia migrada',
      category: 'connectivity', location: { source: 'manual', label: 'Edificio de prueba A' },
      work: seen.fields.work,
    };
    const disk = deviceDisk([
      [OFFLINE_QUEUE_V1_KEY, JSON.stringify([legacyOperation])],
      [OFFLINE_INCIDENTS_V1_KEY, JSON.stringify([legacyIncident])],
    ]);

    const opened = await openOfflineStore(disk);
    expect(opened.migration).toMatchObject({ status: 'migrated', operations: 1, basesDerived: 1 });
    expect(await opened.queue.list()).toEqual([{ ...legacyOperation, base: { version: seen.version, fields: { work: seen.fields.work } } }]);

    const summary = await new SyncPendingOperationsUseCase({ queue: opened.queue, gateway: gateway('technician-1') }).execute();
    expect(summary.outcomes).toEqual([{
      operationId: 'op-v1-legacy-note-01', incidentId: id, result: 'confirmed', reason: 'applied',
      appliedWith: 'op-v1-legacy-note-01',
    }]);
    expect(await opened.queue.list()).toEqual([]);
    expect((await snapshotAs('coordinator-1', id)).appliedOperationIds).toContain('op-v1-legacy-note-01');

    trace['cola-migrada-sincronizada'] = { migration: opened.migration, outcomes: summary.outcomes, diskKeys: disk.keys() };
  });
});
