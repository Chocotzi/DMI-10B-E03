/** @jest-environment node */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedOperation } from '../src/campusops/contracts';
import type { Incident } from '../src/campusops/domain/Incident';
import { createOfflineOperation } from '../src/campusops/domain/OfflineSync';
import type { SyncableOperation } from '../src/campusops/domain/OfflineSync';
import {
  OFFLINE_INCIDENTS_V1_KEY,
  OFFLINE_INCIDENTS_V2_KEY,
  OFFLINE_QUEUE_V1_KEY,
  OFFLINE_QUEUE_V2_KEY,
  OFFLINE_SCHEMA_VERSION_KEY,
  OfflineStoreUnavailableError,
  migrateOfflineStore,
  openOfflineStore,
} from '../src/campusops/infrastructure/OfflineStoreMigration';
import type { MigratableStorage } from '../src/campusops/infrastructure/OfflineStoreMigration';

/**
 * Week 08 — migration v1 → v2 with injected failures (AC-03).
 *
 * `Disk` stands for the device storage: it outlives every "app process"
 * (each `storageOn(disk)` call). Faults are injected at the storage level,
 * like a disk error or the OS killing the app in the middle of a write.
 * With WEEK08_TRACE_DIR set (tools/week-08-trace.mjs) the observed states are
 * written to <dir>/generated-migration-trace.json (ignored by Git).
 */
type Disk = Map<string, string>;

type FaultPlan = Readonly<{
  /** setItem(key) throws and nothing is written. */
  failSetItemFor?: string;
  /** setItem(key) writes, then throws (lost acknowledgement). */
  writeThenFailFor?: string;
  /** setItem(key) silently writes a truncated value. */
  corruptWriteFor?: string;
  /** setItem(key) writes, then the process "dies": every later call throws. */
  crashAfterSetItemFor?: string;
}>;

function storageOn(disk: Disk, plan: FaultPlan = {}): MigratableStorage {
  let crashed = false;
  const alive = (): void => {
    if (crashed) throw new Error('proceso detenido (simulado)');
  };
  return {
    getItem: async (key) => {
      alive();
      return disk.get(key) ?? null;
    },
    setItem: async (key, value) => {
      alive();
      if (plan.failSetItemFor === key) throw new Error(`falla inyectada al escribir ${key}`);
      if (plan.corruptWriteFor === key) {
        disk.set(key, value.slice(0, Math.floor(value.length / 2)));
        return;
      }
      disk.set(key, value);
      if (plan.writeThenFailFor === key) throw new Error(`falla inyectada tras escribir ${key}`);
      if (plan.crashAfterSetItemFor === key) {
        crashed = true;
        throw new Error(`proceso detenido tras escribir ${key}`);
      }
    },
    removeItem: async (key) => {
      alive();
      disk.delete(key);
    },
  };
}

/** Exact bytes stored per key: used to prove that nothing changed. */
function rawDisk(disk: Disk): Record<string, string> {
  return Object.fromEntries([...disk.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function idsIn(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item: { operationId?: string; id?: string; status?: string; version?: number }) => (
        item.operationId !== undefined ? `${item.operationId}:${item.status ?? '?'}` : `${item.id ?? '?'}@v${item.version ?? '?'}`
      ));
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.values(parsed as Record<string, Incident>).map((item) => `${item.id}@v${item.version}`);
    }
    return parsed;
  } catch {
    return `ilegible (${raw.length} bytes)`;
  }
}

/** Readable summary of the disk for the trace and the report. */
function describeDisk(disk: Disk): Record<string, unknown> {
  return {
    keys: [...disk.keys()].sort(),
    schemaVersion: disk.get(OFFLINE_SCHEMA_VERSION_KEY) ?? null,
    queueV1: idsIn(disk.get(OFFLINE_QUEUE_V1_KEY)),
    incidentsV1: idsIn(disk.get(OFFLINE_INCIDENTS_V1_KEY)),
    queueV2: idsIn(disk.get(OFFLINE_QUEUE_V2_KEY)),
    incidentsV2: idsIn(disk.get(OFFLINE_INCIDENTS_V2_KEY)),
  };
}

const trace: Record<string, unknown> = {};

afterAll(() => {
  const directory = process.env.WEEK08_TRACE_DIR;
  if (directory) {
    writeFileSync(
      join(directory, 'generated-migration-trace.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: trace }, null, 2)}\n`,
      'utf8',
    );
  }
});

const createdAt = '2026-10-24T18:00:00-06:00';

/** Synthetic incidents from the public contract, as cached by the v1 app. */
const v1Incidents: readonly Incident[] = [
  {
    id: 'campus-inc-001', version: 1, title: 'Sin conexión en laboratorio ficticio',
    description: 'Sin conexión en laboratorio ficticio', category: 'connectivity',
    location: { source: 'manual', label: 'Edificio de prueba A' },
    work: { assignedTechnicianId: 'technician-1', status: 'assigned' },
  },
  {
    id: 'campus-inc-002', version: 4, title: 'Fuga simulada', description: 'Fuga simulada', category: 'water',
    location: { source: 'manual', label: 'Zona manual ficticia' },
    work: { assignedTechnicianId: 'technician-1', status: 'in_progress' },
  },
];

/** Pending work of technician-1 written with schema v1 (no base snapshot). */
const v1Queue: readonly QueuedOperation[] = [
  {
    operationId: 'op-v1-start-001', incidentId: 'campus-inc-001', baseVersion: 1, actorId: 'technician-1',
    action: 'start', payload: {}, status: 'queued', createdAt,
  },
  {
    operationId: 'op-v1-note-002', incidentId: 'campus-inc-001', baseVersion: 1, actorId: 'technician-1',
    action: 'comment', payload: { text: 'Nota sin conexión: switch ficticio revisado.' }, status: 'queued', createdAt,
  },
  {
    operationId: 'op-v1-photo-003', incidentId: 'campus-inc-001', baseVersion: 1, actorId: 'technician-1',
    action: 'add_evidence', payload: { evidenceId: 'evidence-ref-001', uploaded: false }, status: 'queued', createdAt,
  },
  {
    operationId: 'op-v1-resolve-004', incidentId: 'campus-inc-002', baseVersion: 3, actorId: 'technician-1',
    action: 'resolve', payload: { diagnosis: 'Válvula ficticia sustituida' }, status: 'conflict', createdAt,
  },
];

const baseOfInc001 = { version: 1, fields: { work: { assignedTechnicianId: 'technician-1', status: 'assigned' } } };

/** v2 = each v1 entry unchanged + its base (null when the cached version differs). */
const expectedV2Queue: readonly SyncableOperation[] = v1Queue.map((operation) => ({
  ...operation,
  base: operation.incidentId === 'campus-inc-001' ? baseOfInc001 : null,
}));

const expectedV2Incidents = { 'campus-inc-001': v1Incidents[0], 'campus-inc-002': v1Incidents[1] };

function v1Disk(): Disk {
  return new Map([
    [OFFLINE_QUEUE_V1_KEY, JSON.stringify(v1Queue)],
    [OFFLINE_INCIDENTS_V1_KEY, JSON.stringify(v1Incidents)],
  ]);
}

function expectMigratedV2(disk: Disk, queue: readonly SyncableOperation[] = expectedV2Queue): void {
  expect([...disk.keys()].sort()).toEqual(
    [OFFLINE_INCIDENTS_V2_KEY, OFFLINE_QUEUE_V2_KEY, OFFLINE_SCHEMA_VERSION_KEY].sort(),
  );
  expect(disk.get(OFFLINE_SCHEMA_VERSION_KEY)).toBe('2');
  expect(JSON.parse(disk.get(OFFLINE_QUEUE_V2_KEY) ?? 'null')).toEqual(queue);
  expect(JSON.parse(disk.get(OFFLINE_INCIDENTS_V2_KEY) ?? 'null')).toEqual(expectedV2Incidents);
}

describe('Week 08 — migración v1 → v2 transaccional (Integrante 3)', () => {
  it('migración válida: conserva incidencias y operaciones pendientes con su identidad y contenido', async () => {
    const disk = v1Disk();
    const before = describeDisk(disk);

    const opened = await openOfflineStore(storageOn(disk));

    expect(opened.migration).toEqual({
      status: 'migrated', schemaVersion: 2, fromVersion: 1, operations: 4, incidents: 2,
      basesDerived: 3, duplicatesCollapsed: 0, recoveredLeftovers: [],
      legacyCleanupPending: false, commitConfirmedAfterError: false,
    });
    expectMigratedV2(disk);
    expect(opened.queueStorageKey).toBe(OFFLINE_QUEUE_V2_KEY);

    // New process over the same disk: nothing to migrate and the same queue.
    const restarted = await openOfflineStore(storageOn(disk));
    expect(restarted.migration.status).toBe('already_current');
    expect(await restarted.queue.list()).toEqual(expectedV2Queue);

    trace['migracion-valida'] = { before, report: opened.migration, after: describeDisk(disk) };
  });

  it('falla inyectada al escribir v2: rollback sin esquema híbrido, la app sigue en v1 y la recuperación termina', async () => {
    const disk = v1Disk();
    const beforeBytes = rawDisk(disk);
    const before = describeDisk(disk);

    const failed = await migrateOfflineStore(storageOn(disk, { failSetItemFor: OFFLINE_INCIDENTS_V2_KEY }));

    expect(failed).toEqual({
      status: 'rolled_back', schemaVersion: 1, failedStep: 'write_incidents_v2',
      reason: `falla inyectada al escribir ${OFFLINE_INCIDENTS_V2_KEY}`,
      rollbackComplete: true, recoveredLeftovers: [],
    });
    // The queue v2 key that WAS written has been removed: the bytes are identical to before.
    expect(rawDisk(disk)).toEqual(beforeBytes);
    const afterFailure = describeDisk(disk);

    // While the disk keeps failing the app works on the intact v1 data...
    const degraded = await openOfflineStore(storageOn(disk, { failSetItemFor: OFFLINE_INCIDENTS_V2_KEY }));
    expect(degraded.schemaVersion).toBe(1);
    expect(degraded.queueStorageKey).toBe(OFFLINE_QUEUE_V1_KEY);
    expect(await degraded.queue.list()).toEqual(v1Queue);
    // ...and an intention captured meanwhile is kept, with its base, by the later migration.
    const capturedWhileDegraded = createOfflineOperation({
      operationId: 'op-degraded-note-005', incidentId: 'campus-inc-001', actorId: 'technician-1',
      action: 'comment', payload: { text: 'Nota capturada con la migración pendiente.' },
      base: baseOfInc001, createdAt,
    });
    await degraded.queue.enqueue(capturedWhileDegraded);

    const recovered = await openOfflineStore(storageOn(disk));
    expect(recovered.migration).toMatchObject({ status: 'migrated', operations: 5, basesDerived: 3 });
    expectMigratedV2(disk, [...expectedV2Queue, capturedWhileDegraded]);

    trace['migracion-fallida-rollback'] = {
      fault: `setItem(${OFFLINE_INCIDENTS_V2_KEY}) lanza error`,
      before,
      report: failed,
      afterFailure,
      afterFailureBytesIdentical: true,
      degradedSchemaVersion: degraded.schemaVersion,
      recoveryReport: recovered.migration,
      afterRecovery: describeDisk(disk),
    };
  });

  it('proceso detenido a mitad de la migración: la clave v2 sin confirmar nunca se lee y se limpia al reiniciar', async () => {
    const disk = v1Disk();
    const beforeBytes = rawDisk(disk);
    const before = describeDisk(disk);

    const crashed = await migrateOfflineStore(storageOn(disk, { crashAfterSetItemFor: OFFLINE_QUEUE_V2_KEY }));

    expect(crashed).toMatchObject({ status: 'rolled_back', failedStep: 'write_queue_v2', rollbackComplete: false });
    const afterCrash = describeDisk(disk);
    // Not committed: no schema pointer, v1 bytes untouched, only an orphan shadow key.
    expect(disk.get(OFFLINE_SCHEMA_VERSION_KEY)).toBeUndefined();
    expect(disk.get(OFFLINE_QUEUE_V1_KEY)).toBe(beforeBytes[OFFLINE_QUEUE_V1_KEY]);
    expect(disk.get(OFFLINE_INCIDENTS_V1_KEY)).toBe(beforeBytes[OFFLINE_INCIDENTS_V1_KEY]);
    expect([...disk.keys()].sort()).toEqual([OFFLINE_INCIDENTS_V1_KEY, OFFLINE_QUEUE_V1_KEY, OFFLINE_QUEUE_V2_KEY].sort());

    const restarted = await openOfflineStore(storageOn(disk));

    expect(restarted.migration).toMatchObject({ status: 'migrated', recoveredLeftovers: [OFFLINE_QUEUE_V2_KEY] });
    expectMigratedV2(disk);
    expect(await restarted.queue.list()).toEqual(expectedV2Queue);

    trace['migracion-interrumpida-recuperacion'] = {
      fault: `el proceso se detiene después de setItem(${OFFLINE_QUEUE_V2_KEY})`,
      before,
      report: crashed,
      afterFailure: afterCrash,
      recoveryReport: restarted.migration,
      afterRecovery: describeDisk(disk),
    };
  });

  it('falla en el commit: se revierte; si la escritura del puntero sí llegó, v2 se conserva', async () => {
    const disk = v1Disk();
    const beforeBytes = rawDisk(disk);

    const failedCommit = await migrateOfflineStore(storageOn(disk, { failSetItemFor: OFFLINE_SCHEMA_VERSION_KEY }));
    expect(failedCommit).toMatchObject({ status: 'rolled_back', failedStep: 'commit', rollbackComplete: true });
    expect(rawDisk(disk)).toEqual(beforeBytes);
    const afterFailedCommit = describeDisk(disk);

    const lostAck = await migrateOfflineStore(storageOn(disk, { writeThenFailFor: OFFLINE_SCHEMA_VERSION_KEY }));
    expect(lostAck).toMatchObject({ status: 'migrated', commitConfirmedAfterError: true });
    expectMigratedV2(disk);

    trace['migracion-commit'] = {
      failedCommit, afterFailedCommit, afterFailedCommitBytesIdentical: true,
      lostAcknowledgement: lostAck, afterLostAcknowledgement: describeDisk(disk),
    };
  });

  it('la relectura detecta una escritura v2 corrupta y revierte sin tocar v1', async () => {
    const disk = v1Disk();
    const beforeBytes = rawDisk(disk);

    const report = await migrateOfflineStore(storageOn(disk, { corruptWriteFor: OFFLINE_QUEUE_V2_KEY }));

    expect(report).toMatchObject({ status: 'rolled_back', failedStep: 'verify_v2', rollbackComplete: true });
    expect(rawDisk(disk)).toEqual(beforeBytes);
    trace['migracion-escritura-corrupta'] = { report, afterFailure: describeDisk(disk) };
  });

  it('datos v1 ilegibles o versión desconocida: no se migra, no se borra y no se entrega una cola que los sobrescriba', async () => {
    const disk: Disk = new Map([
      [OFFLINE_QUEUE_V1_KEY, '[{"operationId":"op-roto-001","incidentId":'],
      [OFFLINE_INCIDENTS_V1_KEY, JSON.stringify(v1Incidents)],
    ]);
    const beforeBytes = rawDisk(disk);

    const report = await migrateOfflineStore(storageOn(disk));
    expect(report).toEqual({
      status: 'blocked', schemaVersion: 1, failedStep: 'validate_v1',
      reason: `${OFFLINE_QUEUE_V1_KEY}: JSON ilegible`,
    });
    await expect(openOfflineStore(storageOn(disk))).rejects.toBeInstanceOf(OfflineStoreUnavailableError);
    expect(rawDisk(disk)).toEqual(beforeBytes);

    const future: Disk = new Map([[OFFLINE_SCHEMA_VERSION_KEY, '3']]);
    await expect(migrateOfflineStore(storageOn(future))).resolves.toMatchObject({ status: 'blocked', schemaVersion: 3 });
    expect(rawDisk(future)).toEqual({ [OFFLINE_SCHEMA_VERSION_KEY]: '3' });

    trace['migracion-datos-ilegibles'] = { report, afterBytesIdentical: true };
  });

  it('es idempotente e inicia limpio en una instalación nueva', async () => {
    const disk = v1Disk();
    await openOfflineStore(storageOn(disk));
    const migratedBytes = rawDisk(disk);

    const again = await migrateOfflineStore(storageOn(disk));
    expect(again).toEqual({ status: 'already_current', schemaVersion: 2, cleanedLegacyKeys: [], legacyCleanupPending: false });
    expect(rawDisk(disk)).toEqual(migratedBytes);

    const fresh: Disk = new Map();
    const opened = await openOfflineStore(storageOn(fresh));
    expect(opened.migration).toEqual({ status: 'fresh_install', schemaVersion: 2 });
    await opened.queue.enqueue(createOfflineOperation({
      operationId: 'op-fresh-start-001', incidentId: 'campus-inc-001', actorId: 'technician-1',
      action: 'start', payload: {}, base: baseOfInc001, createdAt,
    }));
    expect([...fresh.keys()].sort()).toEqual([OFFLINE_QUEUE_V2_KEY, OFFLINE_SCHEMA_VERSION_KEY].sort());

    trace['migracion-idempotente'] = { again, fresh: describeDisk(fresh) };
  });
});
