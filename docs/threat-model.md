# Modelo de amenazas inicial - Semana 3

## Activos y fronteras

| Activo | Frontera de confianza | Protección |
|---|---|---|
| Incidencias y asignaciones | Cliente -> servicio CampusOps | Autorización por actor y rol en el backend |
| Tokens y datos de sesión | Backend -> cliente/logs | No registrar credenciales; sanitizar telemetría |
| Ubicación, correo y fotografías | Dominio -> telemetría | Redacción de campos sensibles |
| Código fuente y configuración CI | Repositorio -> GitHub Actions | Secret scan y workflow con `contents: read` |

## Amenazas priorizadas y controles verificables

| ID | Amenaza | Control | Verificación |
|---|---|---|---|
| T1 | Un reportante consulta una incidencia de otra persona. | El backend comprueba actor y visibilidad antes de devolver el recurso. | `course-tests/T1-acceso-incidencias-ajenas.test.ts` espera HTTP 403. |
| T2 | Un actor sin perfil coordinador intenta reasignar una incidencia. | Las acciones de asignación se autorizan por rol y requieren una clave de idempotencia. | `course-tests/T2-reasignacion-sin-permiso.test.ts` espera HTTP 403. |
| T3 | Un log expone token, correo o coordenadas. | `redactForTelemetry` reemplaza campos sensibles por `[REDACTED]` y conserva contexto técnico. | `course-tests/T3-sanitizacion-telemetria.test.ts` comprueba redacción y ausencia de valores. |
| T4 | Una credencial llega al repositorio o a un artefacto de prueba. | `tools/secret-scan.mjs` termina con código distinto de cero al detectar patrones declarados. | `course-tests/T4-secret-scan.test.ts` ejecuta el escáner contra un archivo temporal. |

## Prioridad

Se atiende primero T1 porque una lectura no autorizada expone información de incidencias y rompe el límite de privacidad del sistema. La autorización se comprueba en el servicio, no sólo ocultando botones en la UI; por eso la prueba usa el backend didáctico y observa la respuesta HTTP.

El riesgo residual es que los fixtures son sintéticos y el servicio está en memoria. La prueba demuestra la regla de autorización, pero no sustituye una revisión de autenticación de producción.
