# Semana 05 — contrato del cliente CampusOps

Fuente: `docs/CAMPUSOPS_API.md` y `course-backend/README.md`. El backend es un simulador local con identidades sintéticas. La app envía `Authorization: Bearer <accessToken>` y `X-Course-Actor: <actorId>`; en pruebas se usan `course-valid-token` y actores públicos. `X-Course-Scenario` sólo selecciona variantes del simulador. Nunca se registra el token, el cuerpo libre ni la ubicación.

| Operación | Solicitud | Respuesta válida |
|---|---|---|
| Lista | `GET /v1/incidents` | `200 { "items": [ResourceDto, ...] }`; `items: []` significa lista vacía. El servidor filtra por actor. |
| Detalle | `GET /v1/incidents/:id` | `200 ResourceDto`; `403` para recurso ajeno, `404` si no existe. El ID se codifica como componente de URL. |
| Crear | `POST /v1/incidents`, `Content-Type: application/json`, `Idempotency-Key` estable (mínimo 8 caracteres); cuerpo `{ "category": IncidentCategory, "description": string, "location": string }` | `201 { "incident": ResourceDto, "operationId": string, "duplicate": false }`; un replay idéntico devuelve `200` y `duplicate: true`. La clave con distinto cuerpo devuelve `409`. Sólo el reportante puede crear. |

`ResourceDto` es `{ id: string, version: number, status: string, payload: object | null }`. `parseRemoteResource` exige ID y estado no vacíos, versión entera segura no negativa y `payload` objeto o `null`. Ignora propiedades futuras del sobre. El cliente valida también `status` en `open | assigned | in_progress | resolved | closed` y, cuando existe `payload`, `category` en las siete categorías del contrato, `description`, `location` y `reporterId` no vacíos, y `assignedTechnicianId` como texto no vacío o `null`. No procesa el objeto antes de validar estos campos.

La app usa `Incident`, separado del DTO. Conserva `id`, `version`, `description`, `category`, estado y técnico asignado. La etiqueta de ubicación del servidor se transforma en `{ source: 'manual', label }`, ya que el backend envía texto y ninguna coordenada. `title` reutiliza la descripción recibida. `createdAt` es opcional porque el backend no lo envía. Campos como `priority`, `notes`, `evidence` e `history` no se inventan ni se usan en el modelo de esta semana.

`payload: null` es un sobre válido sin datos de dominio. En detalle se devuelve `{ kind: 'empty', id, reason: 'null_payload' }`. En lista, los registros con payload nulo se enumeran en `unavailableIds` y no se convierten en incidencias. `items: []` produce una lista vacía válida. Un sobre o payload malformado produce `{ kind: 'error', code: 'invalid_contract' }`; no se trata como lista vacía ni se fabrican valores.

El cliente `HttpIncidentClient` devuelve resultados tipados: `success`, `empty` o `error`. Los códigos de error son `invalid_request`, `invalid_contract`, `timeout`, `network`, `server` (HTTP 5xx) y `http` (otros estados); los errores HTTP conservan el número de estado, nunca el cuerpo libre. `fetch` y la lectura JSON tienen timeout configurable y las excepciones se convierten en resultados. Las pantallas deben consumir estos resultados mediante un caso de uso o adaptador; ninguna pantalla debe llamar a `fetch`.

Pruebas reproducibles: `npm test -- --ci --runInBand course-tests/public/week-05.test.ts course-tests/week-05-client.test.ts` usa respuestas simuladas inyectadas, sin Internet. `npm run backend:self-test` verifica el simulador local. Las variantes `nullable`, `malformed`, `slow` y `server_error` son deterministas. Un timeout de escritura no demuestra que el servidor no haya guardado: repetir `create` con la misma clave evita duplicados.
