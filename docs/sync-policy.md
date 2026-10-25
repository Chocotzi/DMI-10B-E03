# Política de sincronización, conflicto e idempotencia — CampusOps (Semana 8)

> Responsable: integrante `a3523110609` (migración de esquemas, manejo de fallas y política de sincronización).
> El modelo de datos, el almacenamiento y la estructura de la cola están en `docs/data-model.md`; el índice de pruebas con comandos y estados observados, en `reports/week-08/migration-tests.json`.

## 1. Decisión

| Pregunta | Regla de CampusOps |
|---|---|
| ¿Qué se conserva? | Toda intención local queda en la cola persistente hasta que el servidor confirma su efecto. La asignación remota nunca se sobrescribe con un dato local antiguo. |
| ¿Qué se combina? | Los cambios a campos distintos desde la misma base (`resolveSync` → `merged`). La intención local se vuelve a enviar sobre la versión remota vigente. |
| ¿Qué requiere resolución? | Un cambio distinto del mismo campo (`work`: inicio local frente a reasignación remota), un 403 por perfil o asignación, una clave reutilizada con otro contenido, una operación inválida o una transición imposible, y una entrada sin base conocida. |

Dónde vive cada parte:

| Parte | Archivo |
|---|---|
| Caso de uso que sincroniza la cola | `src/campusops/application/SyncPendingOperationsUseCase.ts` |
| Reglas puras: intención, base, comparación JSON, identidad derivada | `src/campusops/domain/OfflineSync.ts` |
| Puerto hacia el servicio | `src/campusops/domain/IncidentSyncGateway.ts` |
| Adaptador HTTP para el backend didáctico | `src/campusops/infrastructure/HttpIncidentSyncGateway.ts` |
| Cola persistente (Benkis) y migración v1→v2 | `src/campusops/infrastructure/PersistentOperationQueueRepository.ts`, `src/campusops/infrastructure/OfflineStoreMigration.ts` |
| Combinación y deduplicación (Cleber) | `resolveSync` y `deduplicateOperations` en `src/course-evaluation/index.ts` |

## 2. Identidad estable e idempotencia

- **Una identidad por intención.** El `operationId` se genera una sola vez, cuando la persona captura la intención (`createOfflineOperation`). Se persiste antes de enviar nada y viaja como `Idempotency-Key`. No se regenera en reintentos, reinicios ni migraciones: la migración v1→v2 conserva cada `operationId` (ver `docs/data-model.md` §4).
- **El mismo contenido en cada reintento.** El cuerpo es siempre `{ ...payload, action, baseVersion }` de la entrada persistida. El servidor guarda una huella canónica por clave:
  - misma clave y mismo contenido → `200` con `duplicate: true`; el efecto queda aplicado una sola vez;
  - misma clave y otro contenido → `409 idempotency_key_reused`. Lo tratamos como error de integridad: la entrada pasa a `conflict` y nunca se reenvía sola con otra clave.
- **Deduplicación local.** `enqueue` aplica `deduplicateOperations`: se conserva la primera operación de cada `operationId` y no se mutan las entradas. La migración usa la misma función.
- **Reenvío sobre una versión nueva.** Cuando hay que combinar cambios, el contenido cambia (`baseVersion`), así que la clave original ya no sirve. Se usa una identidad derivada y determinista, `<operationId>:rebase:v<versiónRemota>` (`rebasedOperationId`). Al ser determinista, una respuesta perdida durante el reenvío también se deduplica.
- **"Ya estaba aplicada".** El historial del servidor registra la clave de cada operación. Si contiene la clave original o una derivada, la entrada se confirma sin volver a enviarla (`already_applied`).

## 3. Detección de conflictos

La detección tiene dos capas.

1. **Servidor, que es la autoridad.** Una `baseVersion` obsoleta responde `409 version_conflict`. Un perfil o una asignación incompatibles responden `403`, según el control de acceso de la semana 6. El cliente envía primero con su `baseVersion` y no decide permisos por su cuenta.
2. **Cliente, comparación de tres vías.** Ante un `version_conflict`, el cliente lee el estado remoto y compara con `resolveSync`, por contenido JSON:
   - `base`: la instantánea guardada en la entrada (esquema v2);
   - `local`: la base con la intención aplicada (`intendedFields`);
   - `remoto`: la versión vigente del servidor.

   `work` agrupa `assignedTechnicianId` y `status`. Por eso una reasignación remota y un inicio local chocan en el mismo campo.

| Respuesta del servidor | Estado en la cola | `reason` | ¿Sale de la cola? |
|---|---|---|---|
| `201` aplicada | se retira | `applied` | Sí |
| `200` con `duplicate: true` | se retira | `replayed_duplicate` | Sí |
| `409 version_conflict` y el historial contiene una clave de la intención | se retira | `already_applied` | Sí |
| `409 version_conflict`, `resolveSync` da `merged` y el reenvío con clave derivada responde `201`/`200` | se retira | `rebased_independent_changes` | Sí, al confirmarse el reenvío |
| `409 version_conflict` y el remoto ya contiene exactamente la misma intención | se retira | `already_applied` | Sí |
| `409 version_conflict` y `resolveSync` da `conflict` | `conflict` | `concurrent_field_conflict`, con los campos en orden | No |
| `409 version_conflict` en una entrada sin base | `conflict` | `base_unknown` | No |
| `403`, o la incidencia dejó de ser visible | `conflict` | `forbidden` | No |
| `409 idempotency_key_reused` | `conflict` | `idempotency_key_reused` | No |
| `409 transition_conflict`, `400`, `404` o `422` | `conflict` | `transition_conflict` / `invalid_operation` | No |
| timeout, falla de red, `5xx` o `2xx` ilegible | `queued` | `timeout` / `network` / `server` / `invalid_response` | No |
| `429` | `queued` | `rate_limited`, con `retryAfterMs` | No |
| `401` | `queued`, y se detiene el ciclo | `unauthenticated` | No |
| el reenvío derivado recibe otro `409 version_conflict` | `queued` | `remote_changed_again` | No |

Un timeout no prueba que el servidor no aplicó la operación. Por eso nunca autoriza descartarla: se repite con la misma clave.

## 4. Caso obligatorio: inicio sin conexión frente a reasignación remota

Este procedimiento está implementado y probado en `course-tests/week-08-sync-integration.test.ts`, caso «reasignación concurrente».

1. `technician-1` ve la incidencia en la versión 2, asignada a él. Esa instantánea queda como base.
2. Sin conexión encola tres intenciones, cada una con su `operationId`: `start`, una nota (`comment`) y una referencia de fotografía (`add_evidence`). La referencia identifica un recurso pendiente; no prueba que la imagen se haya subido.
3. Mientras tanto, `coordinator-1` reasigna la incidencia a `technician-2`, que queda en la versión 3.
4. La app se cierra y se vuelve a abrir. La cola se recupera con la misma identidad y el mismo contenido.
5. Al reconectar, el servidor responde `403` al `start`, porque `technician-1` ya no está asignado. La entrada pasa a `conflict` con su contenido intacto. La nota y la foto de la misma incidencia no se envían (`blocked_by_previous_operation`) y tampoco se descartan.
6. El servidor conserva la asignación de `technician-2` en la versión 3; no se aplicó ningún efecto antiguo.
7. Coordinación revisa el conflicto con `reviewConflict`, que aplica `resolveSync` a la base guardada, a la intención y a su vista del servidor. El resultado es `{ kind: 'conflict', fields: ['work'] }`, y las entradas no se mutan.
8. Repetir la sincronización no reenvía ni borra nada: la entrada queda como `awaiting_resolution`.

**Cómo se informa.** El caso de uso devuelve, por cada operación, `result`, `reason` y, cuando aplica, `conflictFields` (`SyncSummary.outcomes`). La cola persiste `status: 'conflict'`, así que el aviso sobrevive al reinicio. La pantalla que muestra los estados pendiente y conflicto corresponde a la semana 10; esta semana el caso de uso ya entrega los datos que necesita.

**Cómo se resuelve.** Lo decide una persona; nunca es automático.
- Si coordinación devuelve la incidencia a `technician-1`, el técnico vuelve a capturar el inicio sobre la versión vigente.
- Si coordinación la mantiene con `technician-2`, el técnico ve que su intención quedó superada.
- En ambos casos, la entrada original sólo sale de la cola por una acción explícita de la persona. Esa acción necesita un método nuevo en `OperationQueueRepository` y se agrega con la interfaz de la semana 10. Mientras tanto nada la borra: el puerto, a propósito, no tiene un método para vaciar la cola.
- Nunca se reintenta un `403` con otro actor ni se fuerza el envío con la versión nueva, porque eso impondría el cambio antiguo.

## 5. Autorización (semana 6)

- La sincronización usa la sesión del propio actor (`Authorization` y `X-Course-Actor`). Nunca cambia de actor ni de rol para que una operación pase.
- Un `403` se convierte en conflicto, no en reintento. El servidor es la autoridad: ocultar un botón no es un control de acceso.
- Un `401` detiene el ciclo y deja todo en `queued`. La renovación de sesión es el flujo de la semana 6 (`coordinateRefresh`); después de renovar, la sincronización se repite con las mismas claves.
- El adaptador HTTP no registra cuerpos ni cabeceras. `SyncSummary` contiene IDs sintéticos, motivos y nombres de campos, pero `mergedFields.work.assignedTechnicianId` es un dato de asignación: si alguna vez se registra un resumen, debe pasar antes por `redactForTelemetry` (semana 4).

## 6. Reintentos y backoff

- **Qué se reintenta.** Sólo las entradas `queued` con un motivo reintentable: `timeout`, `network`, `server`, `rate_limited`, `invalid_response` y `remote_changed_again`. Siempre con la misma clave y el mismo contenido.
- **Dentro de un ciclo.** Cada entrada recibe a lo sumo un envío, más un reenvío derivado cuando hay que combinar cambios. No hay bucles dentro del ciclo.
- **Entre ciclos.** `nextSyncDelayMs(failedCycles, retryAfterMs)` calcula `min(30 s, 1 s · 2^(n−1))`, sin bajar de un `Retry-After` válido (con tope de 5 min); el resultado siempre es finito. `SyncSummary.failedCycles` y `nextAttemptInMs` le dan al llamador lo que necesita, y vuelven a `0` y `null` cuando ya no queda trabajo reintentable. Con el backend real se observó lo siguiente: un `500` dio `1000 ms`; después, un `429` con `retry-after: 1` dio `retryAfterMs = 1000` y `2000 ms` en el segundo ciclo fallido.
- **Qué no se reintenta.** Los conflictos y el `401`: necesitan una persona o una sesión nueva.
- **Sin límite de intentos.** La cola no se rinde con intenciones pendientes, porque eso sería una pérdida silenciosa. El tope está en la demora, no en el número de intentos. Los reintentos acotados por solicitud, con `Retry-After`, son el tema de la semana 9 (`planRetry`) y no se implementan aquí.
- **Quién dispara el ciclo.** En esta semana el ciclo se invoca desde las pruebas. El disparador por reconexión dentro de la app se conecta junto con la interfaz de la semana 10.

## 7. Cuándo se retira una operación de la cola

Sólo `markConfirmed` elimina entradas, y sólo en estos casos:
1. el servidor aplicó la operación (`201`);
2. el servidor reconoció un reenvío (`200` con `duplicate: true`);
3. el historial del servidor contiene su clave original o una derivada;
4. el estado remoto ya contiene exactamente la misma intención, comparando los campos que la intención cambia. Nunca se aplica a acciones aditivas como `comment` o `add_evidence`, porque no cambian campos comparables;
5. el reenvío derivado se confirmó.

Cualquier otro resultado conserva la entrada, ya sea en `queued` o en `conflict`.

## 8. Orden

- La cola se procesa en orden de inserción.
- Si una entrada de una incidencia no se confirma, las siguientes de esa misma incidencia esperan (`blocked_by_previous_operation`). Así se respeta el orden causal; por ejemplo, `resolve` va después de `start`. Las entradas de otras incidencias siguen su curso.
- Un `401` detiene el ciclo completo.

## 9. Relación con la migración

- `openOfflineStore` ejecuta la migración antes de entregar la cola, así que la sincronización siempre trabaja sobre el esquema activo.
- Si hubo rollback, la cola sigue funcionando sobre la v1 intacta. Las intenciones capturadas entonces conservan su base y se migran después.
- Si el estado no se puede usar (datos ilegibles o versión desconocida), no se entrega ninguna cola, de modo que nada puede sobrescribir esos datos.
- Una entrada migrada sin base no puede probar que los cambios son independientes: ante un `409` queda en conflicto (`base_unknown`). Si la base se pudo derivar de la caché v1, sigue el flujo normal. La prueba «la cola migrada desde v1 conserva su identidad y se sincroniza» lo demuestra.

## 10. Pruebas que respaldan cada regla

Comando de la suite: `npm test -- --ci --runInBand course-tests/week-08-sync-integration.test.ts course-tests/week-08-sync-policy.test.ts`. Los estados observados se generan con `npm run trace:week-08` en `reports/week-08/generated-sync-trace.json`.

| Regla | Prueba | `id` en `migration-tests.json` |
|---|---|---|
| Conflicto de reasignación: se conservan la intención local y la asignación remota | `week-08-sync-integration`: «reasignación concurrente…» | `conflicto-reasignacion` |
| Combinar cambios independientes sin mutar las entradas | `week-08-sync-integration`: «cambios independientes…»; `course-tests/week-08.test.ts`; `course-tests/public/week-08.test.ts` | `combinacion-cambios-independientes` |
| Respuesta perdida: un solo efecto con la misma identidad | `week-08-sync-integration`: «respuesta perdida…» | `operacion-repetida-respuesta-perdida` |
| `5xx` y `429` no retiran la entrada; backoff entre ciclos | `week-08-sync-integration`: «error del servidor y 429…» | `operacion-sin-confirmacion` |
| Clave reutilizada, operación inválida, `401`, `2xx` ilegible, aplicada antes de un cierre, entrada sin base, cambio remoto repetido, backoff e inmutabilidad | `course-tests/week-08-sync-policy.test.ts` | `politica-casos-limite` |
| Deduplicación local por `operationId` | `course-tests/week-08-offline-queue.test.ts` (Benkis); `course-tests/week-08.test.ts` (Cleber) | `deduplicacion-operationId` |
| Cola recuperada tras reiniciar | `course-tests/week-08-offline-queue.test.ts`; reinicios dentro de `week-08-sync-integration` | `reinicio-sin-conexion` |

## 11. Límites conocidos

- La interfaz para mostrar y resolver conflictos, y el disparador por reconexión, corresponden a la semana 10. `App.tsx` todavía no compone `openOfflineStore` ni el caso de uso.
- Resolver un conflicto de forma explícita (descartar o volver a capturar) necesita un método nuevo en el puerto. Hoy sólo existen `markConfirmed` y `markConflict`.
- El motivo del conflicto no se persiste; sólo queda `status: 'conflict'`. Se recalcula al volver a sincronizar o al revisar con `reviewConflict`.
- Los reintentos acotados por solicitud corresponden a la semana 9 (`planRetry`).
- El backend didáctico guarda su estado en memoria; las pruebas lo levantan en un puerto libre y nunca lo exponen a Internet.
