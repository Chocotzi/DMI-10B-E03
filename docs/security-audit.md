# Auditoría de seguridad y privacidad - Semana 4

## Alcance

La revisión cubre el backend educativo de CampusOps, el manejo de configuración y la telemetría. Los tokens usados por el proyecto son fixtures ficticios para pruebas; no son credenciales institucionales.

## Hallazgos y acciones

| ID | Hallazgo | Riesgo | Acción realizada | Evidencia |
| --- | --- | --- | --- | --- |
| SEC-01 | Los tokens ficticios del backend estaban repetidos como literales en varios módulos. | Un cambio posterior podría dejar valores inconsistentes o promover copiar fixtures a un entorno real. | Se centralizaron en variables de entorno con valores fallback únicamente para el fixture local. Se declararon en `.env.example` sin valores secretos. | `docs/evidence/backend-env-config.txt` |
| SEC-02 | No existía una frontera única para enviar datos a telemetría de forma segura. | Un nuevo log podría imprimir tokens, correos o coordenadas. | Se agregó `logTelemetry`, que aplica `redactForTelemetry` antes de llamar a `console.info`. | `docs/evidence/telemetry-sanitized.txt` |
| SEC-03 | Un archivo `.env` local podría contener secretos y terminar en Git. | Exposición accidental de credenciales mediante un commit. | Se verificó que `.env` está en `.gitignore` y no está registrado por Git. La prueba de auditoría comprueba ambos controles. | `docs/evidence/gitignore-env.txt` |

## Controles verificados

- `course-tests/security-audit.test.ts` comprueba la sanitización real de token, correo y ubicación, y verifica el control de `.env`.
- `course-backend/self-test.mjs` confirma que los contratos del backend siguen funcionando después de extraer la configuración.
- Las pruebas T1, T2, T3 y T4 de la Semana 3 continúan pasando.
- No se agregaron credenciales reales. Los valores fallback son explícitamente fixtures de curso y pueden reemplazarse mediante variables de entorno.

## Hallazgo 1 - Tokens ficticios repetidos en el backend

### Problema encontrado

Los tokens del fixture educativo estaban escritos como literales repetidos en `course-backend/campusops.mjs` y `course-backend/server.mjs`.

### Riesgo

Aunque son valores ficticios, repetirlos facilita inconsistencias y crea un patrón que podría trasladarse accidentalmente a un entorno real con credenciales verdaderas.

### Antes

Los módulos comparaban directamente contra literales como `course-valid-token` y `course-refresh-0`.

### Después

Los valores se centralizaron en `COURSE_VALID_TOKEN`, `COURSE_REFRESH_TOKEN` y `COURSE_NEXT_REFRESH_TOKEN`, leídos desde variables de entorno con fallback exclusivamente para el fixture local. `.env.example` sólo contiene los nombres de las variables, sin credenciales.

### Evidencia

La evidencia está en `docs/evidence/backend-env-config.txt`. El comando `node course-backend/self-test.mjs` terminó con `Controlled backend self-test passed.`

## Hallazgo 2 - Riesgo de imprimir información sensible en telemetría

### Problema encontrado

No había una frontera única que obligara a sanitizar los datos antes de enviarlos a la consola. Un nuevo código podría registrar accidentalmente tokens, correos o coordenadas.

### Riesgo

Los logs pueden conservarse, compartirse o ser visibles para personas que no necesitan acceder a datos privados.

### Antes

Cada llamada futura a `console.info` podía recibir objetos sin una regla central de sanitización.

### Después

Se agregó `src/security/safeLogger.ts`. Su función `logTelemetry` aplica `redactForTelemetry` antes de llamar a `console.info`, reemplazando campos sensibles por `[REDACTED]`.

### Evidencia

La evidencia está en `docs/evidence/telemetry-sanitized.txt`. La prueba `course-tests/security-audit.test.ts` espía `console.info` y verifica que token, correo y ubicación no se emitan en claro.

## Hallazgo 3 - Protección del archivo `.env`

### Problema encontrado

Un archivo `.env` local podría contener credenciales y subirse accidentalmente si no está excluido del repositorio.

### Riesgo

Un commit público podría exponer secretos de desarrollo o de un servicio externo.

### Solución y control verificado

`.gitignore` contiene `.env`, y la comprobación de Git confirma que no hay un archivo `.env` registrado. Este hallazgo se documenta como control preventivo verificado; las dos correcciones de código de esta actividad son los hallazgos 1 y 2.

### Evidencia

La evidencia está en `docs/evidence/gitignore-env.txt`. `git ls-files .env` no devuelve ninguna ruta y `git check-ignore .env` devuelve `.env`.

## Limitaciones y seguimiento

El backend continúa siendo una implementación educativa en memoria y no debe desplegarse como autenticación institucional. En un entorno real, los valores de configuración deberían venir de un gestor de secretos y rotarse fuera del repositorio.
