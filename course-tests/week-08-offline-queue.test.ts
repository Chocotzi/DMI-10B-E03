import {
  OFFLINE_QUEUE_STORAGE_KEY,
  PersistentOperationQueueRepository,
} from '../src/campusops/infrastructure/PersistentOperationQueueRepository';
import type { KeyValueStorage } from '../src/campusops/infrastructure/PersistentOperationQueueRepository';
import type { QueuedOperation } from '../src/campusops/contracts';

/**
 * A fake device disk: a plain Map that lives OUTSIDE any
 * PersistentOperationQueueRepository instance. Creating a new repository
 * instance against the same backing Map is the test's stand-in for "close
 * the app process and open it again" — nothing is shared via JS memory
 * between the two instances, only via this storage.
 */
function createFakeDeviceStorage(): KeyValueStorage {
  const backingStore = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(backingStore.has(key) ? (backingStore.get(key) as string) : null),
    setItem: (key, value) => {
      backingStore.set(key, value);
      return Promise.resolve();
    },
  };
}

function offlineStartOperation(overrides?: Partial<QueuedOperation>): QueuedOperation {
  return {
    operationId: 'op-offline-start-001',
    incidentId: 'campus-inc-001',
    baseVersion: 1,
    actorId: 'technician-1',
    action: 'start',
    payload: {
      notes: 'Inicio de atención sin conexión: fuga revisada, pendiente reparar válvula.',
      evidenceId: 'evidence-ref-001',
    },
    status: 'queued',
    createdAt: '2026-10-24T18:00:00-06:00',
    ...overrides,
  };
}

describe('Week 08 — Offline operation queue persistence (Reinicio sin conexión)', () => {
  it('conserva identidad y contenido de una operación encolada por un técnico sin conexión tras "reiniciar la app"', async () => {
    const deviceStorage = createFakeDeviceStorage();
    const pendingOperation = offlineStartOperation();

    // Antes de cerrar la app: el técnico, sin conexión, encola el inicio de atención.
    const queueBeforeRestart = new PersistentOperationQueueRepository({ storage: deviceStorage });
    await queueBeforeRestart.enqueue(pendingOperation);

    // "Reinicio": nueva instancia sin estado en memoria previo, sobre el MISMO
    // almacenamiento persistido (equivalente a volver a abrir la app).
    const queueAfterRestart = new PersistentOperationQueueRepository({ storage: deviceStorage });
    const recovered = await queueAfterRestart.list();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(pendingOperation);
    // La identidad estable de operación (operationId) es la que permite al
    // backend detectar un reintento más adelante; debe sobrevivir intacta.
    expect(recovered[0]?.operationId).toBe('op-offline-start-001');
  });

  it('conserva una referencia de fotografía pendiente como recurso no subido, no como archivo ya enviado', async () => {
    const deviceStorage = createFakeDeviceStorage();
    const operationWithPendingPhoto = offlineStartOperation({
      operationId: 'op-offline-evidence-002',
      payload: { evidenceId: 'evidence-ref-pending-002', uploaded: false },
    });

    const queue = new PersistentOperationQueueRepository({ storage: deviceStorage });
    await queue.enqueue(operationWithPendingPhoto);

    const queueAfterRestart = new PersistentOperationQueueRepository({ storage: deviceStorage });
    const [recovered] = await queueAfterRestart.list();

    expect(recovered?.payload).toEqual({ evidenceId: 'evidence-ref-pending-002', uploaded: false });
  });

  it('no retira una operación de la cola ante un conflicto; sólo la retira al confirmarla el backend', async () => {
    const deviceStorage = createFakeDeviceStorage();
    const operation = offlineStartOperation({ operationId: 'op-conflict-003' });

    const queue = new PersistentOperationQueueRepository({ storage: deviceStorage });
    await queue.enqueue(operation);

    await queue.markConflict('op-conflict-003');
    const afterConflict = await queue.list();
    expect(afterConflict).toHaveLength(1);
    expect(afterConflict[0]?.status).toBe('conflict');
    // Marcar el conflicto no debe mutar el resto de los campos de la operación.
    expect(afterConflict[0]?.payload).toEqual(operation.payload);
    expect(afterConflict[0]?.baseVersion).toBe(operation.baseVersion);

    await queue.markConfirmed('op-conflict-003');
    const afterConfirm = await queue.list();
    expect(afterConfirm).toHaveLength(0);
  });

  it('no duplica una operación reintentada con el mismo operationId antes de confirmarse', async () => {
    const deviceStorage = createFakeDeviceStorage();
    const original = offlineStartOperation({ operationId: 'op-retry-004', payload: { notes: 'primer intento' } });
    const retryWithDifferentInMemoryContent = offlineStartOperation({
      operationId: 'op-retry-004',
      payload: { notes: 'reintento tras reconexión intermitente' },
    });

    const queue = new PersistentOperationQueueRepository({ storage: deviceStorage });
    await queue.enqueue(original);
    await queue.enqueue(retryWithDifferentInMemoryContent);

    const result = await queue.list();
    expect(result).toHaveLength(1);
    // Se conserva la primera operación encolada (misma política que
    // deduplicateOperations ya probada en course-tests/week-08.test.ts).
    expect(result[0]?.payload).toEqual({ notes: 'primer intento' });
  });

  it('usa la clave de almacenamiento de esquema v1 declarada en docs/data-model.md', async () => {
    const deviceStorage = createFakeDeviceStorage();
    const queue = new PersistentOperationQueueRepository({ storage: deviceStorage });
    await queue.enqueue(offlineStartOperation());

    const raw = await deviceStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toHaveLength(1);
  });

  it('lanza un error explícito si se usa el almacenamiento por defecto sin el paquete nativo instalado', async () => {
    const queueWithoutInjectedStorage = new PersistentOperationQueueRepository();
    await expect(queueWithoutInjectedStorage.list()).rejects.toThrow(
      /async-storage/i,
    );
  });
});
