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

> **Dependencia instalada (actualización en la rama `dev-carlos`):** `@react-native-async-storage/async-storage` quedó agregado a `package.json`/`package-lock.json` con la versión `2.2.0`, la que Expo SDK 57 declara compatible (`node_modules/expo/bundledNativeModules.json`; `npx expo install` elige la misma). El adaptador sigue resolviendo el módulo de forma diferida: en Jest no existe el módulo nativo y, sin un `storage` inyectado, lanza un error explícito; nunca falla en silencio ni simula persistencia que no existe. La migración (§4) usa además `removeItem`, que AsyncStorage también implementa (`MigratableStorage`).

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
- `markConfirmed(operationId)` es la **única** operación que elimina una entrada de la cola persistida. Se invoca sólo tras una respuesta que confirme que el efecto quedó aplicado una sola vez (`201`, o `200` con `duplicate: true`; ver `docs/sync-policy.md` §7).
- `markConflict(operationId)` actualiza el `status` a `conflict` **sin eliminar la entrada** y sin mutar el resto de sus campos (`incidentId`, `actorId`, `payload`, etc. permanecen intactos para que la persona pueda resolver el conflicto más tarde).
- No existe ningún método que borre la cola completa ante un error de red o un conflicto; esa posibilidad se eliminó intencionalmente de la interfaz para que ningún llamador pueda "limpiar todo" por accidente.

## 4. Versión de esquema, migración y recuperación

> Implementación y pruebas de este apartado: integrante `a3523110609` (`src/campusops/infrastructure/OfflineStoreMigration.ts`, `course-tests/week-08-migration.test.ts`). Se respetan los nombres de clave y la regla «escribir v2 en una clave nueva y borrar v1 sólo después de comprobar v2» que fijaba la primera versión de este documento.

### 4.1 Esquemas

| Versión | Claves | Contenido |
|---|---|---|
| v1 | `campusops.offlineQueue.v1`, `campusops.incidents.v1`; sin puntero de versión (ausente = v1) | Cola: arreglo plano de `QueuedOperation` (§1), escrito por `PersistentOperationQueueRepository`. Caché: arreglo de `Incident` (entidad de §1). La primera versión de este documento ya contemplaba las «incidencias cacheadas», pero en `dev-benkis` ningún adaptador las escribía; por eso la migración trata la clave ausente como caché vacía. |
| v2 (actual) | `campusops.schemaVersion` = `"2"`, `campusops.offlineQueue.v2`, `campusops.incidents.v2` | Cola: cada entrada v1 sin cambios, más `base: { version, fields } \| null`, la instantánea de la incidencia al capturar la intención. Caché: objeto `{ [incidentId]: Incident }`. |

**Por qué existe v2.** Con v1, después de reiniciar sólo se conoce `baseVersion`. Así no se puede distinguir un cambio remoto independiente de uno incompatible, que es lo que decide `resolveSync` (ver `docs/sync-policy.md` §3). Indexar la caché por `id` evita incidencias repetidas.

### 4.2 Transformación v1 → v2

`transformV1ToV2` es pura y no muta sus entradas.

- **Qué se conserva.** Cada operación conserva `operationId`, `incidentId`, `baseVersion`, `actorId`, `action`, `payload` (incluidas notas y referencias `evidenceId`), `status` y `createdAt`, en el mismo orden.
- **Cómo se obtiene `base`.**
  - Se deriva de la caché v1 sólo si la incidencia cacheada tiene `version === baseVersion` (`fields: { work }`).
  - Si no coincide, queda en `null`: la base es desconocida y, ante un `409`, la entrada pasa a conflicto para revisión en vez de combinarse a ciegas.
  - Una entrada que ya traía una `base` válida (capturada mientras la app trabajaba en v1 después de un rollback) la conserva.
- **Duplicados.** Las operaciones repetidas por `operationId` se resuelven con `deduplicateOperations` (se conserva la primera). Las incidencias repetidas, con la de mayor versión.
- **Datos ilegibles.** Si los datos v1 son ilegibles o no cumplen el esquema, no se migra ni se borra nada (`blocked`), y `openOfflineStore` no entrega una cola que pudiera sobrescribirlos.

### 4.3 Procedimiento atómico

AsyncStorage no tiene transacciones entre claves. La atomicidad se obtiene con claves sombra y un único punto de commit.

1. **Leer el puntero.** Si vale `"2"`, el almacén ya está al día y sólo se limpian claves v1 sobrantes. Si tiene una versión desconocida, el resultado es `blocked` y no se toca nada.
2. **Recuperar.** Las claves v2 que existan sin el puntero `"2"` son restos de una ejecución interrumpida que nunca se confirmó; se borran antes de migrar.
3. **Leer y validar v1** y transformarlo en memoria.
4. **Escribir v2** en las claves nuevas (sombra). Las claves v1 no se modifican.
5. **Releer** cada clave v2 y compararla, cadena contra cadena, con lo escrito.
6. **Commit.** Una sola escritura: `campusops.schemaVersion = "2"`. Es el único momento en que v2 pasa a ser el esquema activo.
7. **Limpiar.** Sólo después del commit se borran las claves v1. Si esa limpieza falla, no hay riesgo: el puntero ya indica v2 y la limpieza se repite al siguiente inicio.

**Rollback.** Cualquier error en los pasos 4 a 6 borra las claves sombra. El puntero sigue sin cambiar y v1 queda idéntico, byte a byte. Si el error ocurrió al escribir el puntero, primero se relee:
- si la escritura sí llegó, v2 es válido y se conserva;
- si no se puede comprobar, el resultado es `blocked` y se decide en el siguiente inicio.

**Lectura.** `openOfflineStore` elige las claves según el puntero, de modo que una clave sombra sin confirmar nunca se lee. Nunca queda activo un estado mitad v1 y mitad v2.

### 4.4 Arranque (`openOfflineStore`)

| Resultado de la migración | Qué hace la app |
|---|---|
| `migrated`, `already_current` o `fresh_install` | Usa la cola sobre `campusops.offlineQueue.v2`. |
| `rolled_back` | Usa la cola sobre la v1 intacta: la app sigue funcionando y la migración se reintenta en el siguiente inicio. |
| `blocked` | Lanza `OfflineStoreUnavailableError` sin modificar datos. |

El almacenamiento por defecto es AsyncStorage, resuelto de forma diferida; también se puede inyectar un `MigratableStorage` (`getItem`/`setItem`/`removeItem`). `App.tsx` todavía no compone este arranque; se conecta junto con la interfaz sin conexión (semana 10).

### 4.5 Fallas inyectadas y estados observados

Comando: `npm test -- --ci --runInBand course-tests/week-08-migration.test.ts`. Los estados (antes, después de la falla y después de recuperar) se generan con `npm run trace:week-08` en `reports/week-08/generated-migration-trace.json`, archivo ignorado por Git. El índice está en `reports/week-08/migration-tests.json`.

| Falla inyectada | Después de la falla | Después de recuperar |
|---|---|---|
| `setItem(campusops.incidents.v2)` lanza error | `rolled_back` en `write_incidents_v2`; bytes idénticos a antes; la app sigue en v1 | El siguiente inicio migra: 4 operaciones v1 más la capturada entretanto, y 2 incidencias |
| El proceso muere justo después de escribir `campusops.offlineQueue.v2` | Puntero ausente, v1 intacto; queda sólo la clave sombra huérfana, que no se lee | Se borra la sombra (`recoveredLeftovers`) y se migra |
| Falla la escritura del puntero (commit) | `rolled_back` en `commit`; bytes idénticos | — |
| La escritura del puntero llega pero reporta error | `migrated` con `commitConfirmedAfterError: true`; v2 se conserva | — |
| Escritura v2 truncada en silencio | La relectura la detecta: `rolled_back` en `verify_v2`; bytes idénticos | — |
| JSON v1 ilegible o versión de esquema `"3"` | `blocked`; no se modifica ni se entrega cola | — |

## 5. Cómo se demuestra "reinicio sin conexión"

La prueba no puede usar memoria de proceso compartida: debe crear una instancia nueva del repositorio de cola apuntando al **mismo almacenamiento persistido**, igual que ocurre cuando Android destruye y vuelve a crear el proceso de la app. Esto se implementa en `course-tests/week-08-offline-queue.test.ts` con un `KeyValueStorage` de prueba cuyo backing store (un `Map`) se crea **una sola vez** y se comparte entre dos instancias distintas de `PersistentOperationQueueRepository`, simulando "cerrar y volver a abrir la app" sin depender de un emulador real. Ver esa prueba para el caso exacto exigido: encolar con el técnico sin conexión → "reiniciar" → verificar identidad (`operationId`) y contenido intactos.
