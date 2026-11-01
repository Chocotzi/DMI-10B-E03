# Política de resiliencia — CampusOps (Semana 09)

Este documento define cómo CampusOps se comporta cuando depende de un servicio
externo que puede fallar: el proveedor de ubicación (geocodificación) y la
sincronización de acciones sobre incidencias.

| Sección | Responsable | Estado |
| --- | --- | --- |
| 1. Proveedor de ubicación y caché | a3523110227 | Listo |
| 2. Selección de ubicación y límites de reintento (`selectIncidentLocation`, `planRetry`) | a3523110609 | Pendiente |
| 3. Reintentos en red y respuesta perdida | a3523110321 | Pendiente |

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

_Pendiente — a3523110609._ Reglas de `selectIncidentLocation` y de
`planRetry`: intentos acotados, `Retry-After`, demoras finitas y `POST` solo
con identidad estable.

## 3. Reintentos en red y respuesta perdida

_Pendiente — a3523110321._ Integración de `planRetry` en la sincronización,
escenario `timeout_after_commit` sin duplicar efectos, y métricas en
`reports/week-09/`.
