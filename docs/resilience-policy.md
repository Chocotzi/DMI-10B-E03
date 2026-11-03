# Política de resiliencia — CampusOps (Semana 09)

Este documento define cómo CampusOps se comporta cuando depende de un servicio
externo que puede fallar: el proveedor de ubicación (geocodificación) y la
sincronización de acciones sobre incidencias.

| Sección | Responsable | Estado |
| --- | --- | --- |
| 1. Proveedor de ubicación y caché | a3523110227 | Listo |
| 2. Selección de ubicación y límites de reintento (`selectIncidentLocation`, `planRetry`) | a3523110609 | Listo |
| 3. Reintentos en red y respuesta perdida | a3523110321 | Listo |

---

## 1. Proveedor de ubicación y caché

### 1.1 Componentes

| Capa | Archivo | Responsabilidad |
| --- | --- | --- |
| domain | `src/campusops/domain/LocationProvider.ts` | Puertos `LocationProvider` y `LocationCache`; tipo `GeocodingLookup`. |
| infrastructure | `src/campusops/infrastructure/HttpGeocodingClient.ts` | Llamada HTTP `GET /v1/geocoding?q=...` con límite de tiempo. |
| infrastructure | `src/campusops/infrastructure/PersistentLocationCache.ts` | Caché persistente sobre el mismo `KeyValueStorage` de la cola offline (semana 8). |
| application | `src/campusops/application/ResolveIncidentLocationUseCase.ts` | Orden de decisión caché → proveedor → caché vencida → manual. |

### 1.2 Contrato del adaptador HTTP

- **Nunca lanza excepciones.** Toda falla se devuelve como dato:
  `{ kind: 'unavailable', code }`.

  | Situación | `code` |
  | --- | --- |
  | Se vence el límite de tiempo (por defecto 1000 ms; incluye leer el cuerpo) | `timeout` |
  | Sin conexión / conexión rechazada | `network` |
  | HTTP 429 | `rate_limited` (+ `retryAfterMs` si el encabezado es válido) |
  | HTTP 5xx | `server` |
  | HTTP 401 | `unauthenticated` |
  | Otro 4xx, consulta vacía o configuración inválida | `invalid_request` |
  | 2xx con cuerpo que no es JSON | `invalid_response` |
- **No valida la forma de la respuesta 2xx.** La entrega como `raw: unknown`.
  La única validación vive en `selectIncidentLocation`, para no tener dos
  reglas distintas de qué es una ubicación válida.
- **No reintenta.** Decidir si se reintenta, y cuánto esperar, es trabajo de
  `planRetry` en la capa que administra el presupuesto de reintentos
  (secciones 2 y 3).
- **`Retry-After`** se acepta en segundos o como fecha HTTP, solo si da una
  demora finita entre 0 y 60 s (`MAX_RETRY_AFTER_MS`). Un valor negativo, no
  numérico o mayor se trata como ausente, para nunca esperar indefinidamente.
- La consulta viaja codificada con `encodeURIComponent` y no se escribe en
  registros.

### 1.3 Orden de decisión de la ubicación

`ResolveIncidentLocationUseCase.execute(query, manualLabel)`:

1. **Caché fresca** (edad < `ttlMs`, por defecto 24 h): se usa sin llamar a la
   red. `origin: 'cache'`.
2. **El proveedor responde** y `selectIncidentLocation` lo acepta: se usa y se
   guarda en caché. `origin: 'provider'`.
3. **El proveedor responde con datos malos** (null, incompletos, coordenadas
   fuera de rango, tipos incorrectos): se usa la etiqueta **manual** y la
   respuesta **no** se guarda. `reason: 'rejected_by_validation'`. No se
   prefiere una caché vieja sobre lo que escribió la persona, porque el
   proveedor sí contestó y su respuesta actual no es confiable.
4. **El proveedor no está disponible** (timeout, 429, 5xx, desconexión) y hay
   una entrada en caché más reciente que `maxStaleMs` (por defecto 7 días): se
   usa esa entrada. `origin: 'stale_cache'`, con el `reason` de la falla.
5. **Cualquier otro caso:** la etiqueta manual, `origin: 'manual'`, con el
   `reason`. **Nunca se inventan coordenadas.**

La etiqueta manual es obligatoria y no puede estar vacía: es el resultado
garantizado, así que la creación de la incidencia nunca se bloquea por el
proveedor.

### 1.4 Reglas de la caché

- **Clave:** la consulta normalizada (sin espacios al inicio o al final,
  espacios repetidos colapsados, minúsculas `es-MX`). "Edificio  A" y
  "edificio a" comparten la misma entrada.
- **Solo se guardan resultados ya validados** por `selectIncidentLocation`.
- **Persistencia:** clave `campusops.geocodingCache.v1` en `KeyValueStorage`.
  Sobrevive al reinicio de la app.
- **Límite:** 50 entradas (`GEOCODING_CACHE_MAX_ENTRIES`). Al pasarse, se
  desaloja la de `storedAt` más antigua.
- **Integridad:** cada lectura vuelve a validar lo guardado. Una entrada
  corrupta o alterada en disco se ignora; nunca se sirve.
- **Invalidación:** por tiempo (`ttlMs` / `maxStaleMs`). Una respuesta válida
  nueva del proveedor reemplaza la entrada.

### 1.5 Evidencia

`course-tests/week-09-geocoding-client.test.ts` levanta el backend del curso
(`course-backend/server.mjs`, doble controlado del proveedor, datos ficticios)
y verifica:

- `success`, `incomplete` e `invalid_coordinates` llegan como respuesta sin
  validar.
- `rate_limited` devuelve 429 con `retryAfterMs: 1000`.
- `server_error` y `malformed` se reportan como no disponibles.
- Un timeout real: el proveedor tarda 1200 ms contra un presupuesto de 200 ms.
- Desconexión, con un puerto donde no escucha nada.
- Una consulta vacía no hace ninguna llamada de red.
- La caché sobrevive al reinicio; cualquier variación de mayúsculas y espacios
  sale de caché; datos inválidos no se guardan; se usa caché vencida ante 429;
  una caché demasiado vieja no se sirve; una caché corrupta se ignora.
- Flujo completo con el adaptador HTTP real.

Las pruebas del caso de uso corren con el `selectIncidentLocation` real en
cuanto deja de ser `pending`. Mientras tanto usan un sustituto que sigue el
contrato publicado en `docs/CAMPUSOPS_API.md`. Ese sustituto solo existe en
la prueba; el código de la app siempre usa la función real.

---

## 2. Selección de ubicación y límites de reintento

Ambas funciones viven en `src/course-evaluation/index.ts`, son puras (sin red,
sin reloj, sin estado) y nunca lanzan excepciones.

### 2.1 `selectIncidentLocation(provider, manualLabel)`

Acepta el resultado del proveedor **solo si** es un objeto (no arreglo) con:

- `label` de tipo `string` que no quede vacío tras `trim()`;
- `latitude` de tipo `number`, finita, en `[-90, 90]`;
- `longitude` de tipo `number`, finita, en `[-180, 180]`.

Entonces devuelve `{ source: 'provider', label, latitude, longitude }` (la
etiqueta recortada y **solo** esos campos; lo demás que mande el proveedor se
descarta). En cualquier otro caso devuelve `{ source: 'manual', label:
manualLabel }`:

| Entrada | Resultado |
| --- | --- |
| `null`, `undefined`, texto, número, arreglo | manual |
| Error como dato (`{ status: 429 }`, `{ kind: 'unavailable' }`, `Error`) | manual |
| Falta `label`, `latitude` o `longitude` | manual |
| `label` vacío, de espacios o no textual | manual |
| Coordenadas fuera de rango, `NaN`, `Infinity` | manual |
| Coordenadas como texto, booleano, `null` u objeto `Number` | manual |
| Límites exactos (`±90`, `±180`, `0`) | provider |

**Nunca se inventan coordenadas.** No se usa `0,0`, el centro del campus ni
la última ubicación conocida: una coordenada falsa no se distingue de una
real y manda a la cuadrilla al lugar equivocado. La etiqueta manual es menos
precisa pero es lo que la persona realmente dijo.

### 2.2 `planRetry(input)`

| Constante | Valor | Motivo |
| --- | --- | --- |
| `RETRY_MAX_ATTEMPT` | 3 | Se reintenta después de los intentos 1, 2 y 3; **desde el 4 no**. Máximo 4 solicitudes por operación. |
| `RETRY_BASE_DELAY_MS` | 500 | Backoff exponencial sin `Retry-After`: 500, 1000, 2000 ms. |
| `RETRY_MAX_DELAY_MS` | 60 000 | Mismo tope que `MAX_RETRY_AFTER_MS` del adaptador HTTP. |

Reglas, en este orden:

1. Entrada que no es objeto → `{ retry: false, delayMs: 0, requiresStableIdempotencyKey: false }`.
2. **Cualquier método que no sea `GET` sin `idempotencyKey` textual no vacía →
   `{ retry: false, delayMs: 0, requiresStableIdempotencyKey: true }`**, sin
   importar el estado. Si la respuesta se perdió después del commit, repetir
   sin identidad estable duplicaría el efecto.
3. `attempt` que no es entero seguro ≥ 1, o mayor a 3 → no se reintenta.
4. Solo son reintentables `timeout`, 408, 429, 500, 502, 503 y 504. Los 2xx,
   4xx restantes (400, 401, 403, 404, 409, 422) y 501 no cambian al repetir.
5. `retryAfterMs` válido = número finito en `[0, 60 000]`; se usa tal cual.
   Negativo, `NaN`, `Infinity`, mayor a 60 s o de otro tipo se ignora y se usa
   el backoff. Así **toda demora es finita** y ≤ 60 s.

El backoff es determinista (sin jitter) para que la función sea pura y
comprobable; si hace falta repartir carga entre clientes, el jitter se añade
en la capa de red (sección 3) sin cambiar este contrato.

### 2.3 Evidencia

`course-tests/week-09.test.ts` (70 pruebas, sin red) y
`course-tests/public/week-09.test.ts` (4) pasan. Con la función real,
`course-tests/week-09-geocoding-client.test.ts` (23) sigue en verde. La
justificación de los límites está en `evidence/week-09/engineering.json`.

## 3. Reintentos en red y respuesta perdida

### 3.1 Dónde vive cada reintento

Dos capas, cada una con una sola responsabilidad:

| Capa | Dónde | Qué decide | Con qué |
| --- | --- | --- | --- |
| Por solicitud | `HttpIncidentSyncGateway` (`submitAction`, `fetchSnapshot`) | Si ESTA llamada HTTP se repite, cuánto esperar y cuándo rendirse | `planRetry` (§2.2) |
| Entre ciclos | `SyncPendingOperationsUseCase` (`nextSyncDelayMs`, ya de la semana 8) | Cuánto esperar antes de reintentar TODA la cola | Backoff propio, no `planRetry` |

`synchronize()` (sincronización normal) y `reconcile()` (resolución tras un
`version_conflict`) de `SyncPendingOperationsUseCase` llegan a la red
únicamente a través de `IncidentSyncGateway`; como su adaptador HTTP aplica
`planRetry` a cada intercambio, **ambos métodos quedan cubiertos** sin que el
caso de uso necesite saber nada de reintentos de red. Esa es la frontera a
propósito: `planRetry` acota una sola llamada (máximo 4 solicitudes); el caso
de uso sigue encargado de que una cola pendiente nunca se abandone, ciclo tras
ciclo, hasta que la persona la resuelva o la conexión vuelva.

### 3.2 Qué se reintenta dentro de una llamada y qué no

| Resultado del intento | `planRetry` interviene | Por qué |
| --- | --- | --- |
| Timeout del cliente (`timeout`) | Sí (`status: 'timeout'`) | Transitorio; con `Idempotency-Key` estable, repetir es seguro — es exactamente el caso de respuesta perdida (§3.3). |
| 408, 429, 500, 502, 503, 504 | Sí | Mismo conjunto publicado en §2.2; un `Retry-After` válido del backend fija la demora, si no hay, se usa el backoff 500/1000/2000 ms. |
| Desconexión (`network`) | No | `planRetry` no tiene entrada para "sin conexión"; insistir de inmediato contra un dispositivo desconectado no ayuda. El intento queda `unavailable: network` y lo retoma el siguiente ciclo de `SyncPendingOperationsUseCase`. |
| 2xx no legible (`invalid_response`) | No | Es ambiguo (¿se aplicó o no?); no está en los estados que `planRetry` conoce. Se deja igual para el siguiente ciclo, con la misma clave. |
| 401, 403, 409, 422, otros 4xx, 501 | No (`planRetry` devuelve `retry: false`) | No transitorios: repetir no cambia el resultado. |

En **todas** las llamadas de escritura (`submitAction`) se usa el mismo
`Idempotency-Key` del inicio al fin, incluidas las de `reconcile()` (que usa
`rebasedOperationId`, también estable). Por eso `planRetry` nunca ve un POST
sin clave aquí: la condición `requiresStableIdempotencyKey` existe para quien
integre el gateway sin generar una, no para este flujo.

### 3.3 Respuesta perdida (`timeout_after_commit`) sin duplicar el efecto

Escenario del backend didáctico: el servidor aplica el cambio y registra la
`Idempotency-Key` de inmediato (antes de intentar responder), pero retiene la
respuesta 1500 ms; si el `timeoutMs` del cliente es menor, el cliente aborta
primero. Sin reintento, la operación queda huérfana hasta el siguiente ciclo
completo (lo que ya demostraba la semana 8). Con `planRetry` conectado al
gateway:

1. **Intento 1:** el cliente aborta por su propio timeout → `{ kind:
   'unavailable', code: 'timeout' }`. `planRetry({ method: 'POST', status:
   'timeout', attempt: 1, idempotencyKey })` → `retry: true, delayMs: 500`.
2. **Intento 2** (misma `Idempotency-Key`): el backend ya tiene la operación
   registrada, así que contesta de inmediato (sin la demora artificial) con
   `duplicate: true` y la versión ya aplicada.
3. El gateway devuelve `{ kind: 'applied', duplicate: true, version }` — una
   sola vez el efecto en el servidor, confirmado en una sola llamada a
   `submitAction`/`execute()`, no en dos ciclos de sincronización.

Esto se demuestra sobre una resolución real (`action: 'resolve'`, con
`diagnosis`) en `course-tests/week-09-retry-integration.test.ts`, contra el
backend del curso levantado como proceso aparte (no un doble que finja el
resultado): tanto a través del gateway solo como de
`SyncPendingOperationsUseCase.execute()` completo, verificando después con un
`fetchSnapshot` fresco que el historial remoto tiene la clave una sola vez y
la incidencia pasó a `resolved` exactamente una vez.

Esto deja una conclusión explícita sobre la semana 8: la prueba
`course-tests/week-08-sync-integration.test.ts` (*"respuesta perdida: lo no
confirmado queda pendiente..."*) describía el comportamiento *antes* de que
existiera el reintento por solicitud — un timeout de escritura se quedaba
`pending` hasta un segundo `execute()` ("reconexión"). Con `planRetry` en el
gateway, ese mismo escenario se resuelve dentro del primer `execute()`: es una
mejora intencional, no una regresión, y la evidencia de la semana 8 sigue
siendo válida para el commit que evaluó (`docs/EVIDENCE_CONTRACT.md` sobre
`commitSha`); no se modificó ese archivo de prueba.

### 3.4 Cuándo rendirse e informar el fallo

- **Por solicitud:** al intento 4 (`attempt > RETRY_MAX_ATTEMPT`), o ante un
  estado no transitorio, o ante `network`/`invalid_response` (que `planRetry`
  no reintenta), el gateway devuelve el resultado final de ESE intento — nunca
  lanza una excepción ni inventa un resultado.
- **Por operación:** ese resultado llega a `SyncPendingOperationsUseCase`
  como un `SyncOutcome` con `result` y `reason` explícitos. Nada se descarta
  en silencio: un fallo persistente queda `pending` (o `conflict`, si no es
  seguro reintentarlo) en cada `SyncSummary`, ciclo tras ciclo, hasta que se
  resuelva — igual que la cola offline de la semana 8.
- **Ubicación manual (secciones 1-2, Benkis/Carlos):** cuando el proveedor de
  geocodificación agota su propio presupuesto (o no hay caché vigente),
  `ResolveIncidentLocationUseCase` nunca "falla": devuelve la etiqueta manual.
  Es la misma filosofía aplicada a un dominio distinto — la incidencia, o la
  sincronización, siempre terminan en un estado observable y nunca se bloquean
  esperando indefinidamente a una red que no responde.

### 3.5 Telemetría

Cada intento HTTP (reintentado o no) se reporta a través de `onAttempt` con
solo los campos técnicos que `docs/CAMPUSOPS_API.md` permite conservar:
`incidentId`, `correlationId` (la `Idempotency-Key`, solo en POST), `method`,
`attempt`, `status`, `durationMs`, `retry`, `delayMs` — nunca cuerpos ni
encabezados — pasados por `redactForTelemetry` (semana 4) antes de salir del
gateway. `course-tests/week-09-retry-integration.test.ts` recoge estos
registros reales y los vuelca, junto con el detalle de cada escenario de
falla inyectada, en `reports/week-09/retry-metrics.json` y
`reports/week-09/fault-injection.json`.

### 3.6 Evidencia

`course-tests/week-09-retry-integration.test.ts` corre contra
`course-backend/server.mjs` levantado como proceso aparte (mismo patrón que
`course-tests/week-08-sync-integration.test.ts`) y cubre: un `GET` que agota
su presupuesto ante un 429 sostenido, respetando el `Retry-After` real; un
`POST` que se recupera de dos 500 transitorios con el backoff progresivo sin
duplicar el efecto; una resolución real con `timeout_after_commit` resuelta en
una sola llamada, por el gateway solo y por el caso de uso completo; el
`fetchSnapshot` de `reconcile()` recuperándose de un 429 pasajero; y una
desconexión real (puerto sin servidor) con un único intento, sin reintento
local. Comandos: `npm test -- --ci --runInBand
course-tests/week-09-retry-integration.test.ts`; con `WEEK09_WRITE_REPORTS=1`
además escribe `reports/week-09/retry-metrics.json` y
`reports/week-09/fault-injection.json` con el `commitSha` real.
