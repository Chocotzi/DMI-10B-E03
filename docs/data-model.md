# Modelo de datos y persistencia offline — CampusOps (Semana 8)

> Responsable: integrante `a3523110227` (Modelo de datos, persistencia offline y cola de operaciones).
> Este documento describe únicamente el alcance de datos/persistencia/cola. La política de combinación,
> conflicto e idempotencia de red se detalla en `docs/sync-policy.md`.

## 1. Entidades y relaciones

```
Incident (1) ──── (0..N) QueuedOperation
   id, version, status, work{assignedTechnicianId,status}, payload
                              │
                              └── operationId, incidentId, baseVersion, actorId, action, payload, status, createdAt
```

| Entidad | Campos | Origen |
|---|---|---|
| `Incident` | `id`, `version`, `title`, `description`, `category`, `location`, `work{assignedTechnicianId, status}`, `createdAt` | `src/campusops/domain/Incident.ts` (ya existente, sin cambios). Se recibe del backend vía `HttpIncidentClient` y se valida con `parseRemoteResource`. |
| `QueuedOperation` | `operationId`, `incidentId`, `baseVersion`, `actorId`, `action`, `payload`, `status`, `createdAt` | **Nuevo**, en `src/campusops/contracts.ts`. Extiende el tipo público `PendingIncidentOperation` (ya definido en el contrato del curso) agregando `status` y `createdAt`, que son necesarios para la cola local pero no forman parte del contrato de red. |

Una incidencia puede tener cero o varias operaciones pendientes asociadas (`incidentId`). Cada operación pendiente referencia la versión base (`baseVersion`) de la incidencia *tal como la conocía el dispositivo cuando se creó la operación*; esa versión es la que usa `resolveSync` (`src/course-evaluation/index.ts`, ya implementado) para detectar si hubo un cambio remoto incompatible.

`status` de una `QueuedOperation` tiene tres valores posibles:

- `queued`: creada localmente, aún no confirmada por el servidor.
- `confirmed`: el servidor aplicó el efecto exactamente una vez (idempotente). **Sólo en este estado se retira de la cola.**
- `conflict`: el servidor reporta una incompatibilidad (ver `docs/sync-policy.md`). Permanece en la cola hasta que una persona resuelva el conflicto; nunca se descarta automáticamente.

Una referencia a fotografía pendiente (`evidenceId`) se guarda como un campo más dentro de `payload` de la operación encolada. Identifica un recurso pendiente de subir; **no implica que el archivo ya se subió**. Mientras la operación no esté `confirmed`, la referencia sigue disponible para reintentar la subida.

## 2. Motor de persistencia local elegido

**Elegido: `@react-native-async-storage/async-storage`** (clave/valor asíncrono, respaldado por `SharedPreferences`/`localStorage` nativo según plataforma).

| Opción | A favor | En contra | Decisión |
|---|---|---|---|
| `@react-native-async-storage/async-storage` | API mínima (`getItem`/`setItem`), suficiente para una cola JSON pequeña (decenas de operaciones, no miles de filas); fácil de simular con un *storage* en memoria en pruebas sin dependencias nativas; es el estándar de facto en apps Expo para datos ligeros. | No tiene transacciones nativas; una migración debe implementar su propia atomicidad "todo o nada" a mano (ver §4). | **Elegida** para esta semana: el volumen de datos (incidencias de prueba + cola de un técnico) no justifica el costo de SQLite todavía. |
| `expo-sqlite` | Transacciones reales (`BEGIN`/`COMMIT`/`ROLLBACK`), mejor a futuro si el catálogo de incidencias crece o se necesitan consultas relacionales. | Mayor superficie de API, requiere build nativo para probarlo end-to-end, y para el tamaño de datos actual es sobre-ingeniería. | Alternativa considerada; se revisará si una semana futura requiere consultas más complejas que listar/filtrar. |

El puerto de dominio (`OperationQueueRepository`, §3) **no depende de AsyncStorage**: depende de una interfaz mínima `KeyValueStorage { getItem, setItem }`. Esto permite swap a `expo-sqlite` (o a cualquier otro motor) sin tocar la lógica de cola, y permite probar la persistencia en Jest sin instalar dependencias nativas (ver `course-tests/week-08-offline-queue.test.ts`).

> **Limitación conocida y declarada:** el entorno de desarrollo actual del equipo no tiene salida de red hacia el registro de npm al momento de escribir este documento, por lo que `@react-native-async-storage/async-storage` **no se agregó todavía a `package.json`/`package-lock.json`**. El adaptador (`PersistentOperationQueueRepository`) ya está escrito contra la interfaz real de ese paquete (`getItem`/`setItem`) y funciona de inmediato en cuanto alguien del equipo con acceso al registro ejecute:
> ```bash
> npm install @react-native-async-storage/async-storage
> ```
> y confirme `npm run typecheck` y `make feedback` en verde. Mientras tanto, si se intenta usar el adaptador por defecto (sin inyectar un `storage`) sin el paquete instalado, lanza un error explícito indicando el comando a ejecutar — nunca falla en silencio ni simula persistencia que no existe.

## 3. Estructura formal de la cola (puerto de dominio)

`src/campusops/domain/OperationQueueRepository.ts`:

```ts
export interface OperationQueueRepository {
  enqueue(operation: QueuedOperation): Promise<void>;
  list(): Promise<readonly QueuedOperation[]>;
  markConfirmed(operationId: string): Promise<void>;
  markConflict(operationId: string): Promise<void>;
}
```

Regla de desalojo (implementada en `PersistentOperationQueueRepository`):

- `enqueue` agrega una operación nueva y aplica `deduplicateOperations` (la misma función pura del contrato de la Semana 8, no una reimplementación) para que reintentar con el mismo `operationId` antes de confirmarse no duplique la entrada en la cola.
- `markConfirmed(operationId)` es la **única** operación que elimina una entrada de la cola persistida. Se invoca sólo tras una respuesta exitosa y no duplicada del backend.
- `markConflict(operationId)` actualiza el `status` a `conflict` **sin eliminar la entrada** y sin mutar el resto de sus campos (`incidentId`, `actorId`, `payload`, etc. permanecen intactos para que la persona pueda resolver el conflicto más tarde).
- No existe ningún método que borre la cola completa ante un error de red o un conflicto; esa posibilidad se eliminó intencionalmente de la interfaz para que ningún llamador pueda "limpiar todo" por accidente.

## 4. Versión de esquema y migración (alcance de este documento)

El almacenamiento persistente de la cola se guarda bajo la clave `campusops.offlineQueue.v1`. El sufijo `v1` es la versión de esquema actual de la cola:

- **v1** (actual): arreglo plano de `QueuedOperation` tal como se define en §1.

Cuando el esquema de la cola o de las incidencias cacheadas cambie (por ejemplo, si una semana futura necesita separar `payload.evidenceId` en una tabla propia de adjuntos), corresponde:

1. Introducir una clave nueva (`campusops.offlineQueue.v2`) en vez de sobrescribir la v1 in-place.
2. Leer v1, transformar en memoria al formato v2, y escribir v2 en una operación atómica (ver siguiente punto) **antes** de borrar la clave v1.
3. Sólo borrar la clave v1 después de confirmar que la lectura de v2 es consistente.

La implementación del *runner* de migraciones, la inyección de una falla a mitad de camino y el rollback/recuperación verificable (caso "Migración válida y fallida" de la tabla del enunciado) son responsabilidad de la persona del equipo encargada de `docs/sync-policy.md` y `reports/week-08/migration-tests.json`; este documento fija el contrato de datos y de nombres de clave que esa migración debe respetar para no romper la cola descrita aquí.

## 5. Cómo se demuestra "reinicio sin conexión"

La prueba no puede usar memoria de proceso compartida: debe crear una instancia nueva del repositorio de cola apuntando al **mismo almacenamiento persistido**, igual que ocurre cuando Android destruye y vuelve a crear el proceso de la app. Esto se implementa en `course-tests/week-08-offline-queue.test.ts` con un `KeyValueStorage` de prueba cuyo backing store (un `Map`) se crea **una sola vez** y se comparte entre dos instancias distintas de `PersistentOperationQueueRepository`, simulando "cerrar y volver a abrir la app" sin depender de un emulador real. Ver esa prueba para el caso exacto exigido: encolar con el técnico sin conexión → "reiniciar" → verificar identidad (`operationId`) y contenido intactos.
