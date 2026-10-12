# Modelo de amenazas — CampusOps (semana 3)

## Alcance y supuestos

Este modelo cubre la aplicación académica CampusOps y su backend didáctico. Usa exclusivamente actores, incidencias, ubicaciones y evidencias ficticias descritos en `docs/CAMPUSOPS.md` y `docs/CAMPUSOPS_API.md`; los tokens `course-*` son fixtures públicos, no secretos de producción. El modelo no convierte al simulador en un servicio institucional ni autoriza guardar datos reales.

La aplicación debe aplicar permisos en el servicio aunque la interfaz o el almacenamiento local hayan sido manipulados. Los controles descritos aquí se prueban de forma reproducible con el backend en memoria y utilidades del repositorio; esa verificación no sustituye la autenticación, revisión de infraestructura y monitoreo de una eventual producción.

## Activos

| Activo | Valor y datos que protege | Propietario o acceso esperado |
|---|---|---|
| Sesión/token | Estado autenticado, token de acceso/refresh y el actor de la solicitud. | Sólo el usuario autenticado; nunca en telemetría ni logs. |
| Fotografías de evidencia | Referencias y archivos de evidencia de una incidencia. | Reportante visible en su reporte; técnico asignado y coordinador según el caso. |
| Ubicación (GPS) | Etiqueta manual, coordenadas o resultado de geocodificación de una incidencia. | Sólo quien puede ver la incidencia; se solicita con mínimo privilegio. |
| Asignaciones de incidencias | Técnico asignado, prioridad, estado, versión e historial de atención. | Coordinador para asignar/reasignar; técnico únicamente en su trabajo asignado. |
| Registros/logs | Correlación, código de error, intento, duración y contexto técnico. | Equipo técnico; sin tokens, identidades, ubicación, fotos ni comentarios internos. |
| Credenciales/configuración de servicios | Variables de entorno, configuración CI y credenciales de proveedores. | Entorno autorizado; fuera de Git y sin permisos de escritura innecesarios en CI. |

## Fronteras de confianza

| Frontera | Datos que la cruzan | Regla de confianza |
|---|---|---|
| App ↔ almacenamiento local | Sesión persistida, cola offline, fotos pendientes y versiones de incidencias. | El contenido local puede quedar obsoleto o ser manipulado; el servidor vuelve a autorizar y valida versión. |
| App ↔ API backend | `Authorization`, actor sintético, DTOs, acciones e idempotency keys. | La API decide visibilidad, rol, asignación y transición; un botón oculto no es un control. |
| App ↔ servicios externos (mapas/geocodificación) | Consulta de zona y respuesta con etiqueta/coordenadas. | La respuesta es no confiable; se valida y existe alternativa de ubicación manual. |
| App ↔ CI/repo público | Código, workflow, reportes y configuración de build. | No se suben `.env` ni secretos; el workflow usa el mínimo `permissions: contents: read`. |
| Usuario ↔ perfiles (reportante / técnico / admin) | Consulta, comentario, evidencia, estado, prioridad, asignación y cierre. | El backend usa actor, perfil y relación propietario/asignado; en CampusOps el perfil administrativo se materializa como coordinador. |

## Amenazas priorizadas, controles y verificación

| ID | Amenaza | Activo afectado | Frontera | Probabilidad | Impacto | Prioridad | Control | Verificación (prueba/comando) | Riesgo residual |
|---|---|---|---|---|---|---|---|---|---|
| T1 | Un reportante intenta consultar una incidencia ajena construyendo la URL o la solicitud manualmente. | Incidencias, fotos, ubicación, notas e historial. | App ↔ API backend; usuario ↔ perfiles. | Media | Alto: expone información privada de una incidencia. | **P1 — primero** | El backend comprueba actor y visibilidad antes de listar o devolver el recurso; la UI no es la autoridad. | `npm test -- --ci --runInBand course-tests/T1-acceso-incidencias-ajenas.test.ts` inicia el backend y exige HTTP 403 para `reporter-2` ante `campus-inc-001`. | El doble usa actores y datos sintéticos en memoria; aún harían falta autenticación y auditoría de producción. |
| T2 | Un reportante o técnico no asignado altera una asignación sin permiso. | Asignaciones, estado, prioridad, versión e historial. | App ↔ almacenamiento local; app ↔ API backend; usuario ↔ perfiles. | Media | Alto: desordena la atención y puede dejar un caso sin responsable. | **P2** | El servicio autoriza `assign` por perfil de coordinador y valida acción, transición, versión e idempotency key antes de modificar. | `npm test -- --ci --runInBand course-tests/T2-reasignacion-sin-permiso.test.ts` envía `assign` como `reporter-1` y exige HTTP 403. | No cubre todavía conflictos de cola offline ni la interfaz de reasignación; se validarán en el hito de sincronización. |
| T3 | La telemetría o un registro filtra token, correo, GPS, fotos, evidencias o historial. | Sesión/token, ubicación, fotografías, registros/logs y asignaciones. | App ↔ almacenamiento local; app ↔ API backend; app ↔ servicios externos. | Media | Alto: una copia de logs puede amplificar una exposición. | **P3** | `redactForTelemetry` recorre objetos/listas sin mutarlos y reemplaza claves sensibles normalizadas por `[REDACTED]`; sólo deja contexto técnico permitido. | `npm test -- --ci --runInBand course-tests/T3-sanitizacion-telemetria.test.ts` verifica redacción de `authorization`, `email` y `location`, y conservación de `incidentId`/`status`. | Texto libre o una nueva clave sensible podría no estar clasificada; se revisa la lista de claves y los puntos de log en cada cambio. |
| T4 | Una credencial o configuración sensible llega al repo público, a CI o a un artefacto. | Credenciales/configuración de servicios y secretos de sesión. | App ↔ CI/repo público. | Media | Alto: permite uso no autorizado del proveedor o del pipeline. | **P4** | `.env` permanece fuera de Git; `tools/secret-scan.mjs` falla ante patrones declarados y el workflow limita permisos a `contents: read`. | `npm test -- --ci --runInBand course-tests/T4-secret-scan.test.ts` crea una credencial ficticia temporal y exige que el scanner falle; `npm test -- --ci --runInBand course-tests/public/week-03.test.ts` comprueba el permiso mínimo del workflow. | El scanner basado en patrones no reconoce todos los proveedores ni secretos ofuscados; se complementa con revisión de PR y rotación/revocación si hubiera exposición. |

## Justificación de prioridad y decisión de control

Se atiende **T1 primero**: una lectura indebida cruza directamente el límite de privacidad de CampusOps y puede revelar, en una sola respuesta, ubicación, fotografías, descripción y asignaciones. La probabilidad es media porque un cliente puede modificar la interfaz o construir una solicitud, mientras que el impacto es alto y afecta varios activos. El control reduce el riesgo porque la decisión se ejecuta en la API, después de recibir la solicitud, y por ello no depende de ocultar una pantalla o botón.

T2 comparte la necesidad de autorización y es segunda porque modifica la operación; su validación de perfil, asignación, transición y versión evita que una cola o cliente no autorizado sobrescriba trabajo. T3 reduce la probabilidad de divulgación secundaria eliminando valores completos antes de emitir el registro. T4 reduce la oportunidad de exfiltración desde el repositorio y CI mediante detección preventiva y mínimo privilegio. La decisión que se registra en `evidence/week-03/engineering.json` es priorizar T1 y su autorización en servicio; debe ser revisada y confirmada por Carlos junto con el equipo antes de congelar la etiqueta de entrega.

Cada **control** de la tabla tiene una **verificación** ejecutable existente en este repositorio. Las pruebas usan sólo IDs, tokens, ubicaciones, correos y claves ficticias; ninguna evidencia contiene credenciales o datos personales reales.
