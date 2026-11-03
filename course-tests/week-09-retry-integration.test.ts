/** @jest-environment node */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPT } from '../src/course-evaluation';
import { SyncPendingOperationsUseCase } from '../src/campusops/application/SyncPendingOperationsUseCase';
import { createOfflineOperation } from '../src/campusops/domain/OfflineSync';
import type { SyncBase, SyncableOperation } from '../src/campusops/domain/OfflineSync';
import { HttpIncidentSyncGateway } from '../src/campusops/infrastructure/HttpIncidentSyncGateway';
import type { RetryAttemptTelemetry, SyncGatewayOptions } from '../src/campusops/infrastructure/HttpIncidentSyncGateway';
import { openOfflineStore } from '../src/campusops/infrastructure/OfflineStoreMigration';
import type { MigratableStorage } from '../src/campusops/infrastructure/OfflineStoreMigration';

/**
 * Week 09 (Cleber, a3523110321) — `planRetry` wired into the real network
 * layer, against the didactic backend (no public Internet, no mocks that
 * fake the outcome). Covers:
 *
 * - `submitAction`/`fetchSnapshot` retry transient failures (timeout, 429
 *   with the backend's real `Retry-After`, 5xx) with progressive backoff,
 *   and give up — reporting the failure, never duplicating an effect — once
 *   `planRetry`'s attempt budget is spent.
 * - `timeout_after_commit` on a real `resolve` action: the server commits,
 *   the client's own timeout fires first, and retrying with the same
 *   `Idempotency-Key` replays instead of resolving the incident twice — both
 *   through the gateway alone and through `SyncPendingOperationsUseCase`
 *   (`synchronize()` and, for a stale base, `reconcile()`).
 * - A real disconnection is NOT retried at the request level: one attempt,
 *   reported as `pending`, left for the next sync cycle.
 *
 * Every attempt is recorded (redacted) and, in `afterAll`, written to
 * reports/week-09/retry-metrics.json (attempts) and
 * reports/week-09/fault-injection.json (one check per scenario), per
 * docs/EVIDENCE_CONTRACT.md.
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

const attempts: RetryAttemptTelemetry[] = [];
const checks: Record<string, unknown>[] = [];

function record(id: string, scenarioType: 'nominal' | 'boundary' | 'failure', command: string, expected: string, observed: string, evidence: string): void {
  checks.push({ id, status: 'pass', scenarioType, command, expected, observed, evidence });
}

afterAll(() => {
  backend?.kill();
  const reportDir = join(process.cwd(), 'reports', 'week-09');
  mkdirSync(reportDir, { recursive: true });
  const commitSha = process.env.WEEK09_RETRY_COMMIT_SHA ?? '0000000000000000000000000000000000000000';
  writeFileSync(
    join(reportDir, 'generated-retry-attempts.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), attempts }, null, 2)}\n`,
    'utf8',
  );
  if (process.env.WEEK09_WRITE_REPORTS) {
    writeFileSync(
      join(reportDir, 'retry-metrics.json'),
      `${JSON.stringify({ schemaVersion: 1, week: 9, commitSha, generatedAt: new Date().toISOString(), attempts }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(reportDir, 'fault-injection.json'),
      `${JSON.stringify({ schemaVersion: 1, week: 9, commitSha, generatedAt: new Date().toISOString(), checks }, null, 2)}\n`,
      'utf8',
    );
  }
});

/** fetch over node:http (same approach as week 05/08), with headers and abort. */
function makeLocalFetch(mutateHeaders?: (method: string, headers: Record<string, string>) => void): typeof fetch {
  return ((input: string, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    const headers = { ...(init?.headers as Record<string, string>) };
    mutateHeaders?.(init?.method ?? 'GET', headers);
    const connection = request(input, {
      method: init?.method ?? 'GET',
      headers,
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
}

const localFetch = makeLocalFetch();

type CallResult = Readonly<{ status: number; body: Record<string, unknown> }>;

/** Direct call used only to prepare the scenario (reporter/coordinator/technician actions, no retry policy involved). */
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

/** A fast, non-real sleep: lets a test assert the retry *decisions* (count, delayMs) without paying their real wall-clock cost. */
const fastSleep = async (): Promise<void> => {};

function gateway(
  actorId: string,
  extra: Omit<SyncGatewayOptions, 'baseUrl' | 'actorId' | 'accessToken'> = {},
): HttpIncidentSyncGateway {
  return new HttpIncidentSyncGateway({
    baseUrl, actorId, accessToken: 'course-valid-token', fetchImpl: localFetch,
    onAttempt: (telemetry) => attempts.push(telemetry),
    ...extra,
  });
}

async function snapshotAs(actorId: string, incidentId: string, extra: Omit<SyncGatewayOptions, 'baseUrl' | 'actorId' | 'accessToken'> = {}) {
  const outcome = await gateway(actorId, extra).fetchSnapshot(incidentId);
  if (outcome.kind !== 'visible') throw new Error(`${actorId} cannot see ${incidentId}: ${outcome.kind}`);
  return outcome.snapshot;
}

/** reporter-1 creates a synthetic incident, coordinator-1 assigns technician-1 (v2) and technician-1 starts it (v3). */
async function incidentInProgress(label: string): Promise<{ id: string; version: number }> {
  const created = await call('reporter-1', '/v1/incidents', {
    category: 'connectivity', description: `Incidencia ficticia ${label}`, location: 'Edificio de prueba A',
  }, `create-${label}`);
  expect(created.status).toBe(201);
  const id = (created.body.incident as { id: string }).id;
  const assigned = await call('coordinator-1', `/v1/incidents/${id}/actions`, {
    action: 'assign', baseVersion: 1, technicianId: 'technician-1',
  }, `assign-${label}`);
  expect(assigned.status).toBe(201);
  const started = await call('technician-1', `/v1/incidents/${id}/actions`, {
    action: 'start', baseVersion: 2,
  }, `start-${label}`);
  expect(started.status).toBe(201);
  return { id, version: (started.body.incident as { version: number }).version };
}

function deviceDisk(): MigratableStorage {
  const disk = new Map<string, string>();
  return {
    getItem: async (key) => disk.get(key) ?? null,
    setItem: async (key, value) => { disk.set(key, value); },
    removeItem: async (key) => { disk.delete(key); },
  };
}

const createdAt = '2026-10-25T10:00:00-06:00';

function offlineOperation(operationId: string, incidentId: string, action: string, base: SyncBase,
  payload: Readonly<Record<string, unknown>> = {}): SyncableOperation {
  return createOfflineOperation({ operationId, incidentId, actorId: 'technician-1', action, payload, base, createdAt });
}

describe('Week 09 — Retry integration against the real backend (Cleber)', () => {
  it('fetchSnapshot: 429 sostenido se reintenta con el Retry-After real del backend y se rinde tras el presupuesto', async () => {
    const { id } = await incidentInProgress('get-429');
    const before = attempts.length;
    const outcome = await gateway('technician-1', { scenario: 'rate_limited' }).fetchSnapshot(id);
    const mine = attempts.slice(before);

    expect(outcome).toEqual({ kind: 'unavailable', code: 'rate_limited' });
    expect(mine).toHaveLength(RETRY_MAX_ATTEMPT + 1);
    expect(mine.map((item) => item.attempt)).toEqual([1, 2, 3, 4]);
    expect(mine.slice(0, 3).every((item) => item.retry && item.delayMs === 1000)).toBe(true);
    expect(mine[3]).toMatchObject({ retry: false, delayMs: 0 });
    // Nunca se registran cuerpos ni encabezados: solo campos técnicos (docs/CAMPUSOPS_API.md).
    for (const item of mine) {
      expect(Object.keys(item).sort()).toEqual(['attempt', 'delayMs', 'durationMs', 'incidentId', 'method', 'retry', 'status']);
    }

    record(
      'get-429-retry-after-real',
      'boundary',
      "fetchSnapshot con scenario 'rate_limited' contra el backend real",
      'Las 3 primeras solicitudes reintentan con delayMs=1000 (Retry-After real); la 4ª se rinde y reporta rate_limited.',
      `4 intentos registrados (${mine.map((item) => `#${item.attempt}:${String(item.status)}`).join(', ')}); resultado final unavailable/rate_limited.`,
      'course-tests/week-09-retry-integration.test.ts — "fetchSnapshot: 429 sostenido..."',
    );
  }, 15000);

  it('submitAction: se recupera de 500 transitorios con backoff progresivo (500/1000 ms) sin duplicar el efecto', async () => {
    const { id, version } = await incidentInProgress('post-recovers');
    const before = attempts.length;

    // Las dos primeras solicitudes golpean el real backend con 500 inyectado por cabecera;
    // la tercera, sin cabecera, llega limpia. Ninguna de las dos primeras toca el estado del
    // servidor: campusops.mjs responde 500 antes de leer la operación.
    let calls = 0;
    const flappy = ((input: string, init?: RequestInit) => {
      calls += 1;
      const headers = { ...(init?.headers as Record<string, string>) };
      if (calls <= 2) headers['X-Course-Scenario'] = 'server_error';
      else delete headers['X-Course-Scenario'];
      return localFetch(input, { ...init, headers });
    }) as typeof fetch;

    const outcome = await gateway('technician-1', { fetchImpl: flappy, sleepImpl: fastSleep }).submitAction({
      idempotencyKey: 'resolve-recovers-01', incidentId: id, action: 'resolve', baseVersion: version,
      payload: { diagnosis: 'Cableado dañado (ficticio)' },
    });
    const mine = attempts.slice(before);

    expect(outcome).toMatchObject({ kind: 'applied', duplicate: false });
    expect(mine.map((item) => item.status)).toEqual([500, 500, 201]);
    expect(mine.map((item) => item.delayMs)).toEqual([RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2, 0]);
    expect(mine.map((item) => item.retry)).toEqual([true, true, false]);

    const after = await snapshotAs('coordinator-1', id);
    expect(after.appliedOperationIds.filter((key) => key === 'resolve-recovers-01')).toHaveLength(1);
    expect(after.fields.work).toMatchObject({ status: 'resolved' });

    record(
      'post-500-recupera-sin-duplicar',
      'boundary',
      "submitAction('resolve') con los 2 primeros intentos forzados a 500 contra el backend real",
      'Backoff 500 ms, 1000 ms y éxito al 3er intento; el historial del servidor registra la clave una sola vez.',
      `status por intento: ${mine.map((item) => item.status).join(',')}; appliedOperationIds con 1 ocurrencia de la clave.`,
      'course-tests/week-09-retry-integration.test.ts — "submitAction: se recupera de 500 transitorios..."',
    );
  }, 15000);

  it('timeout_after_commit en una resolución real: el servidor aplica el diagnóstico pero el cliente agota su propio tiempo; el reintento con la misma Idempotency-Key reproduce, no duplica', async () => {
    const { id, version } = await incidentInProgress('lost-response');
    const before = attempts.length;
    const key = 'resolve-lost-response-01';

    const outcome = await gateway('technician-1', {
      scenario: 'timeout_after_commit', timeoutMs: 300, sleepImpl: fastSleep,
    }).submitAction({
      idempotencyKey: key, incidentId: id, action: 'resolve', baseVersion: version,
      payload: { diagnosis: 'Falla intermitente (ficticio)' },
    });
    const mine = attempts.slice(before);

    // 1er intento: el cliente aborta a los 300 ms mientras el servidor ya comprometió el cambio
    // (el backend tarda 1500 ms en contestar bajo este escenario). 2º intento, misma clave: el
    // backend ve la operación ya registrada y contesta de inmediato con duplicate=true, sin la
    // demora artificial — así planRetry resuelve la respuesta perdida dentro de un solo llamado.
    expect(mine.map((item) => item.status)).toEqual(['timeout', 200]);
    expect(outcome).toEqual({ kind: 'applied', duplicate: true, version: version + 1 });

    const after = await snapshotAs('coordinator-1', id);
    expect(after.version).toBe(version + 1);
    expect(after.fields.work).toMatchObject({ status: 'resolved' });
    expect(after.appliedOperationIds.filter((appliedId) => appliedId === key)).toHaveLength(1);

    record(
      'timeout-after-commit-resolve-no-duplica',
      'failure',
      "submitAction('resolve') con scenario 'timeout_after_commit' y timeoutMs=300 contra el backend real",
      'El 1er intento aborta por timeout del cliente; el 2º, con la misma Idempotency-Key, recibe duplicate=true sin repetir el efecto en el servidor.',
      `intentos: timeout, 200(duplicate=true); versión remota avanzó una sola vez (${version} -> ${version + 1}); 1 sola entrada de la clave en el historial.`,
      'course-tests/week-09-retry-integration.test.ts — "timeout_after_commit en una resolución real..."',
    );
  }, 15000);

  it('SyncPendingOperationsUseCase.synchronize(): una resolución encolada con respuesta perdida se confirma en un solo ciclo, sin duplicar', async () => {
    const { id, version } = await incidentInProgress('lost-response-usecase');
    const seen = await snapshotAs('technician-1', id);
    const disk = deviceDisk();
    const operation = offlineOperation('op-lost-resolve-01', id, 'resolve',
      { version: seen.version, fields: seen.fields }, { diagnosis: 'Sensor desconectado (ficticio)' });
    await (await openOfflineStore(disk)).queue.enqueue(operation);

    const summary = await new SyncPendingOperationsUseCase({
      queue: (await openOfflineStore(disk)).queue,
      gateway: gateway('technician-1', { scenario: 'timeout_after_commit', timeoutMs: 300, sleepImpl: fastSleep }),
    }).execute();

    expect(summary.outcomes).toEqual([{
      operationId: 'op-lost-resolve-01', incidentId: id, result: 'confirmed', reason: 'replayed_duplicate',
      appliedWith: 'op-lost-resolve-01',
    }]);
    expect(summary.failedCycles).toBe(0);
    expect(summary.nextAttemptInMs).toBeNull();
    expect(await (await openOfflineStore(disk)).queue.list()).toEqual([]);

    const after = await snapshotAs('coordinator-1', id);
    expect(after.version).toBe(version + 1);
    expect(after.appliedOperationIds.filter((appliedId) => appliedId === 'op-lost-resolve-01')).toHaveLength(1);

    record(
      'usecase-resolve-respuesta-perdida-un-ciclo',
      'nominal',
      'SyncPendingOperationsUseCase.execute() con una resolución encolada y scenario timeout_after_commit',
      'confirmed/replayed_duplicate en el PRIMER ciclo (sin esperar a un reintento de ciclo completo); cola vacía al terminar.',
      `outcomes=${JSON.stringify(summary.outcomes)}; failedCycles=0; cola final vacía.`,
      'course-tests/week-09-retry-integration.test.ts — "SyncPendingOperationsUseCase.synchronize()..."',
    );
  }, 15000);

  it('reconcile(): tras un version_conflict, el fetchSnapshot de resolución también reintenta con planRetry ante un 429 pasajero', async () => {
    const { id } = await incidentInProgress('reconcile-429');
    const seen = await snapshotAs('technician-1', id);
    // Cambio remoto independiente (prioridad) que deja obsoleta la base local sin pisar `work`.
    const prioritized = await call('coordinator-1', `/v1/incidents/${id}/actions`, {
      action: 'prioritize', baseVersion: seen.version, priority: 'high',
    }, `prioritize-reconcile-429`);
    expect(prioritized.status).toBe(201);

    const disk = deviceDisk();
    const operation = offlineOperation('op-reconcile-429-01', id, 'comment',
      { version: seen.version, fields: seen.fields }, { text: 'Nota ficticia' });
    await (await openOfflineStore(disk)).queue.enqueue(operation);

    const before = attempts.length;
    let getCalls = 0;
    const flappyGet = ((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = { ...(init?.headers as Record<string, string>) };
      if (method === 'GET') {
        getCalls += 1;
        if (getCalls === 1) headers['X-Course-Scenario'] = 'rate_limited';
        else delete headers['X-Course-Scenario'];
      }
      return localFetch(input, { ...init, headers });
    }) as typeof fetch;

    const summary = await new SyncPendingOperationsUseCase({
      queue: (await openOfflineStore(disk)).queue,
      gateway: gateway('technician-1', { fetchImpl: flappyGet, sleepImpl: fastSleep }),
    }).execute();
    const mine = attempts.slice(before).filter((item) => item.method === 'GET');

    expect(summary.outcomes).toEqual([{
      operationId: 'op-reconcile-429-01', incidentId: id, result: 'confirmed', reason: 'rebased_independent_changes',
      appliedWith: expect.stringContaining('op-reconcile-429-01') as unknown as string,
      mergedFields: expect.anything() as unknown as Record<string, unknown>,
    }]);
    expect(mine.map((item) => item.status)).toEqual([429, 200]);
    expect(mine[0]).toMatchObject({ retry: true, delayMs: 1000 });

    record(
      'reconcile-fetchsnapshot-429-recupera',
      'boundary',
      'reconcile() tras version_conflict, con el 1er GET forzado a 429 contra el backend real',
      'El GET de reconciliación reintenta igual que un submitAction; la operación local se rebasea y confirma sin perderse.',
      `GET status por intento: ${mine.map((item) => item.status).join(',')}; outcome final confirmed/rebased_independent_changes.`,
      'course-tests/week-09-retry-integration.test.ts — "reconcile(): tras un version_conflict..."',
    );
  }, 15000);

  it('una desconexión real (sin servidor escuchando) no se reintenta a nivel de solicitud: un solo intento, se deja al ciclo de sincronización', async () => {
    const before = attempts.length;
    const disconnected = new HttpIncidentSyncGateway({
      baseUrl: 'http://127.0.0.1:1', actorId: 'technician-1', accessToken: 'course-valid-token', timeoutMs: 300,
      fetchImpl: localFetch,
      onAttempt: (telemetry) => attempts.push(telemetry),
    });
    const outcome = await disconnected.submitAction({
      idempotencyKey: 'disconnected-attempt-01', incidentId: 'campus-inc-001', action: 'comment',
      baseVersion: 1, payload: { text: 'no debería salir' },
    });
    const mine = attempts.slice(before);

    expect(outcome).toEqual({ kind: 'unavailable', code: 'network' });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'network', retry: false, delayMs: 0 });

    record(
      'desconexion-un-solo-intento',
      'failure',
      "submitAction contra un puerto sin servidor (baseUrl: 'http://127.0.0.1:1')",
      'planRetry no tiene veredicto para "network": un solo intento, sin reintento local; el fallo se reporta para el ciclo de sincronización.',
      `1 intento registrado (status=network, retry=false); outcome unavailable/network.`,
      'course-tests/week-09-retry-integration.test.ts — "una desconexión real..."',
    );
  }, 10000);
});
