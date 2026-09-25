# Auditoría de seguridad — Semana 4

Fecha de revisión: 25 de septiembre de 2026.

La revisión se realizó sobre el código real de CampusOps. Todos los valores usados en las pruebas son ficticios y pertenecen a los dominios reservados `.test`; no se usaron credenciales ni datos personales reales.

## Hallazgos

| # | Hallazgo | Riesgo | Solución aplicada | Evidencia |
|---|---|---|---|---|
| 1 | `redactForTelemetry` no estaba implementada y lanzaba una excepción | Un objeto enviado a telemetría podía conservar autorización, correo, ubicación, fotografías o comentarios internos sin sanitizar | Se implementó una sanitización recursiva, no mutante y normalizada para claves sensibles | [`telemetria-sanitizada.txt`](evidence/telemetria-sanitizada.txt) |
| 2 | El chequeo de salud generaba errores con el estado HTTP o el nombre del contrato interno | Si el error llegaba a registros o a la interfaz, revelaba detalles útiles para reconocer el comportamiento interno del servicio | Las distintas fallas públicas ahora producen el mismo mensaje genérico, sin estado ni detalle del contrato | [`errores-genericos.txt`](evidence/errores-genericos.txt) |
| 3 | `.gitignore` sólo cubría el nombre exacto `.env` | Variantes habituales como `.env.local` y `.env.production` podían agregarse por accidente con secretos de desarrollo o despliegue | Se ignoran `.env.*` y se conserva explícitamente `.env.example`, que sólo contiene nombres o valores públicos de ejemplo | [`archivos-env-ignorados.txt`](evidence/archivos-env-ignorados.txt) |
| 4 | Dos archivos de metadatos `.DS_Store` estaban versionados | Metadatos locales innecesarios podían llegar al repositorio y revelar información del entorno de trabajo | Se agregó `.DS_Store` a `.gitignore` y se retiraron los dos archivos del control de versiones | [`metadatos-eliminados.txt`](evidence/metadatos-eliminados.txt) |

## Hallazgo 1 — Telemetría sin sanitización

### Problema encontrado

La función `redactForTelemetry` de `src/course-evaluation/index.ts` estaba pendiente: cualquier intento de usar el control terminaba con una excepción en vez de producir un objeto seguro para registros. El proyecto define incidencias con ubicación y técnico asignado, y su contrato contempla además autorización, correo, fotografías y comentarios internos.

### Riesgo

Registrar el objeto original puede copiar datos personales, credenciales de sesión y detalles sensibles de una incidencia a consolas, recolectores de errores o servicios de observabilidad. Esos registros suelen conservarse y ser visibles para más personas que la información operativa original.

### Solución

Se implementó un recorrido recursivo de objetos y arreglos. Las claves sensibles se normalizan a minúsculas y sin guiones, y su valor completo se sustituye por `[REDACTED]`. El control conserva contexto técnico permitido, no modifica el objeto recibido y corta referencias circulares.

### Antes

```ts
export function redactForTelemetry(_input: unknown): unknown {
  return pending('redactForTelemetry');
}
```

### Después

```ts
export function redactForTelemetry(input: unknown): unknown {
  // Recorre la estructura y sustituye cada clave sensible.
  return redact(input);
}
```

### Evidencia

La prueba usa únicamente una autorización, correo, ubicación y API key ficticios. Verifica que todos quedan ocultos, que `incidentId`, `status` y encabezados no sensibles se conservan, y que la entrada original no se modifica. El resultado reproducible está en [`docs/evidence/telemetria-sanitizada.txt`](evidence/telemetria-sanitizada.txt).

## Hallazgo 2 — Detalles internos en mensajes de error

### Problema encontrado

`src/api/courseBackend.ts` distinguía públicamente dos fallas y construía uno de los mensajes con el estado HTTP recibido:

```ts
throw new Error(`Backend health failed with ${response.status}`);
throw new Error('Backend health contract mismatch');
```

### Riesgo

Si un consumidor imprime o muestra esas excepciones, una persona externa puede diferenciar la respuesta del servidor de una incompatibilidad del contrato. Evitar esos detalles no sustituye los controles de acceso, pero reduce la información técnica expuesta y evita que termine en registros no controlados.

### Solución

Ambos caminos devuelven el mismo mensaje seguro. La interfaz sólo necesita saber que el servicio no está disponible; el estado y la forma interna del contrato no forman parte de su mensaje público.

### Después

```ts
const SAFE_UNAVAILABLE_MESSAGE = 'El servicio no está disponible';
throw new Error(SAFE_UNAVAILABLE_MESSAGE);
```

### Evidencia

Dos pruebas simulan una respuesta HTTP 503 y un cuerpo incompatible. Ambas reciben el mensaje genérico y comprueban que no aparezcan `503` ni `contract`. Véase [`docs/evidence/errores-genericos.txt`](evidence/errores-genericos.txt).

## Hallazgo 3 — Variantes de archivos de entorno sin ignorar

### Problema encontrado

La regla original era únicamente `.env`. No coincidía con nombres comunes como `.env.local` o `.env.production`.

### Riesgo

Estos archivos suelen contener configuración específica de una computadora o un despliegue. Aunque este ejercicio no usa secretos reales, dejar esas rutas disponibles para Git facilita que una credencial real se publique accidentalmente en el futuro.

### Solución

Se añadieron una regla para todas las variantes y una excepción explícita para la plantilla segura:

```gitignore
.env
.env.*
!.env.example
```

### Evidencia

`git check-ignore` confirma que `.env`, `.env.local` y `.env.production` están ignorados. Una comprobación negativa confirma que `.env.example` sigue visible para Git. Véase [`docs/evidence/archivos-env-ignorados.txt`](evidence/archivos-env-ignorados.txt).

## Hallazgo 4 — Metadatos locales dentro del repositorio

### Problema encontrado

Git ya rastreaba `.DS_Store` y `reports/.DS_Store`. Son archivos generados por Finder y no forman parte de la aplicación ni de las evidencias académicas.

### Riesgo

Aunque estos dos archivos no contenían credenciales, conservar metadatos locales incrementa la información innecesaria publicada sobre el entorno de trabajo y ensucia las revisiones. La ausencia de una regla también permitía que aparecieran copias nuevas en otras carpetas.

### Solución

Se agregó `.DS_Store` a `.gitignore` y se retiraron del índice las dos copias existentes.

### Evidencia

La regla coincide tanto en la raíz como dentro de `reports/`, y `git ls-files '*DS_Store'` ya no devuelve archivos. Véase [`docs/evidence/metadatos-eliminados.txt`](evidence/metadatos-eliminados.txt).

## Comprobación final

Se ejecutaron en conjunto las pruebas pública y adicional de seguridad, la comprobación de tipos, ESLint y el escáner de secretos del evaluador. Todos finalizaron correctamente; el resumen está en [`docs/evidence/verificacion-final.txt`](evidence/verificacion-final.txt).

No se incorporó ningún archivo `.env`, token real, contraseña, API key real ni dato personal de terceros.
