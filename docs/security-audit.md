# Auditoría de seguridad — Semana 4

Proyecto: CampusOps (equipo DMI-10B-E03) · Rama: `week4/security-audit-chocotzi` · Fecha: 2026-09-24

Todos los datos usados en las pruebas son ficticios (`demo_key_123`, `demo-access-token-123`, `persona@campusops.test`, `.env*` de prueba creados y borrados en el momento). No hay credenciales ni datos personales reales en este documento ni en `docs/evidence/`.

## Alcance y método

Revisé el código propio (`App.tsx`, `src/`), la configuración (`.gitignore`, `.env.example`, `app.json`, `package.json`, `Makefile`), los workflows de `.github/`, el backend didáctico (`course-backend/`), el evaluador (`tools/`) y el historial completo de Git (todas las ramas). No modifiqué el backend didáctico, el evaluador, las pruebas del curso ni los workflows. Mis cambios están en `.gitignore`, `.env.example`, `src/course-evaluation/index.ts`, el índice de Git (dos `.DS_Store` quitados) y archivos nuevos (una prueba, este documento y `docs/evidence/`).

Comandos base de la revisión: `git ls-files`, `git grep -n` (secretos, `console.*`, almacenamiento local, mensajes de error), `git log --all -G<patrón>` (secretos en el historial), `git check-ignore -v` y `git add --dry-run .` (qué subiría un `git add .`).

## Hallazgos

| # | Hallazgo | Riesgo | Solución aplicada | Evidencia |
|---|---|---|---|---|
| 1 | `.gitignore` solo ignoraba el nombre exacto `.env` (línea 8): `.env.local`, `.env.production` y `.env.*.local` quedaban visibles para Git | Un `git add .` subiría las credenciales locales al repositorio | Se ignoran `.env.*` y se re-incluye `.env.example` (commit `eb9e289`) | [gitignore-env-antes.txt](evidence/gitignore-env-antes.txt), [gitignore-env-despues.txt](evidence/gitignore-env-despues.txt) |
| 2 | Dos archivos `.DS_Store` (raíz y `reports/`) rastreados desde el commit inicial `6295ff7` | Filtran nombres de carpetas/archivos de la máquina que los creó, incluidos archivos que no están en el repositorio | Se quitaron del índice con `git rm --cached` y se agregó `.DS_Store` a `.gitignore` (commit `93d5307`) | [ds-store-antes.txt](evidence/ds-store-antes.txt), [ds-store-despues.txt](evidence/ds-store-despues.txt) |
| 3 | No existía ningún control para registrar objetos sin exponer datos: `redactForTelemetry` (`src/course-evaluation/index.ts`) lanzaba un error | Un `console.log` de una incidencia o de una respuesta de sesión imprimiría token, ubicación y técnico asignado en logs | Se implementó `redactForTelemetry` con pruebas negativas (commit `66c174d`) | [logs-sanitizados-antes.txt](evidence/logs-sanitizados-antes.txt), [logs-sanitizados-despues.txt](evidence/logs-sanitizados-despues.txt) |
| 4 | El backend didáctico tiene tokens fijos (`course-valid-token`, `course-refresh-0`) y `access-control-allow-origin: *` | Si se reutilizara fuera del aula, cualquiera podría autenticarse y cualquier página web leería sus respuestas | **No corregido (riesgo aceptado)**: son fixtures públicos del curso; se documentan las condiciones de uso | [fixture-credenciales-cors.txt](evidence/fixture-credenciales-cors.txt) |

Resumen: 4 hallazgos identificados, 3 corregidos con evidencia antes/después, 1 aceptado y justificado.

---

## Hallazgo 1 — Variantes de `.env` sin ignorar

### Problema encontrado

En `.gitignore` la línea 8 era únicamente `.env`. Ese patrón solo coincide con ese nombre exacto. Expo y las herramientas basadas en dotenv también leen archivos como `.env.local`, `.env.production` o `.env.development.local`, que son justo donde se suelen poner valores locales. Comprobé que `.env` no existe en el árbol de trabajo, no está rastreado y nunca estuvo en el historial (ver "Revisado sin hallazgo"), así que **no se filtró nada real**; el problema era la protección incompleta.

### Riesgo

Cualquiera de esos archivos aparecería como "sin rastrear" y se agregaría con `git add .` (el comando que sugiere la propia guía de la actividad). Una URL con credenciales o una llave de un servicio de mapas quedaría en el historial, y revertir el archivo después no lo borra del historial. Este riesgo ya estaba en el registro de riesgos del proyecto (riesgo 2 en `docs/risk-register.md`).

### Solución

Se ignoran todas las variantes de `.env` y se re-incluye explícitamente `.env.example`, que sí debe subirse porque no contiene valores reales. Además se agregó una advertencia en `.env.example`: todo valor `EXPO_PUBLIC_*` se incluye en el bundle de la app, así que nunca debe llevar secretos.

### Antes

```gitignore
.env
```

### Después

```gitignore
.env
.env.*
!.env.example
```

### Evidencia

Con cuatro archivos ficticios (`.env`, `.env.local`, `.env.production`, `.env.development.local`) creados solo para la prueba:

Antes (`git add --dry-run . | grep -F .env`): se agregarían tres de los cuatro.

```text
add '.env.development.local'
add '.env.local'
add '.env.production'
```

Después: los cuatro quedan ignorados y `.env.example` sigue sin ignorarse (no aparece en `git check-ignore`) y rastreado.

```text
.gitignore:8:.env	.env
.gitignore:9:.env.*	.env.local
.gitignore:9:.env.*	.env.production
.gitignore:9:.env.*	.env.development.local
```

Transcripciones completas: [antes](evidence/gitignore-env-antes.txt) y [después](evidence/gitignore-env-despues.txt).

---

## Hallazgo 2 — Archivos `.DS_Store` rastreados

### Problema encontrado

`git ls-files` listaba `.DS_Store` y `reports/.DS_Store`, agregados en el commit inicial (`6295ff7`). Son metadatos de Finder (macOS) que la persona que abrió la carpeta dejó sin querer.

### Riesgo

Un `.DS_Store` guarda los nombres de las entradas de esa carpeta **en la máquina que lo creó**, aunque esos archivos no estén en el repositorio. Puede revelar nombres de documentos privados. Severidad real aquí: **baja**. Extraje los nombres legibles del de `reports/` y solo contiene `week-01` (y el de la raíz, `reports`), sin información sensible. Lo corregí porque es un hábito de higiene barato y porque cada `git add .` desde macOS los volvería a agregar.

### Solución

`git rm --cached` para quitarlos del índice (siguen en disco) y `.DS_Store` en `.gitignore`.

### Antes

```text
$ git ls-files | grep -F .DS_Store
.DS_Store
reports/.DS_Store
```

### Después

```text
$ git ls-files | grep -F .DS_Store
[exit=1]                       # sin resultados
$ git check-ignore -v .DS_Store reports/.DS_Store docs/.DS_Store
.gitignore:16:.DS_Store	.DS_Store
.gitignore:16:.DS_Store	reports/.DS_Store
.gitignore:16:.DS_Store	docs/.DS_Store
```

Un `.DS_Store` nuevo creado en `docs/` para la prueba ya no aparece en `git add --dry-run .`.

### Evidencia y límite

Transcripciones: [antes](evidence/ds-store-antes.txt) y [después](evidence/ds-store-despues.txt).

Límite: los archivos **siguen en el historial** (commit `6295ff7`; `git log --diff-filter=A` lo confirma en la captura "después"). No reescribí el historial porque su contenido no es sensible y forzar un `push` sobre una rama compartida por tres personas costaría más que el beneficio.

---

## Hallazgo 3 — Sin control contra fuga de datos en logs

### Problema encontrado

`redactForTelemetry` en `src/course-evaluation/index.ts` (líneas 15–17 antes del cambio) era un stub que lanzaba `redactForTelemetry must be implemented in the assigned week`. Por lo tanto no había una forma segura de registrar un objeto del dominio o una respuesta HTTP. Hoy **no existe ningún `console.*` en `src/`, `App.tsx` ni `index.ts`** (`git grep` sin resultados), así que no hay una fuga activa: el hallazgo es un control ausente, y la prueba pública `course-tests/public/week-04.test.ts` fallaba por eso.

### Riesgo

En cuanto alguien depure con `console.log(incident)` o `console.log(await response.json())`, saldrían en el log el técnico asignado (`assignedTechnicianId`), la ubicación (`location`) y, en la respuesta de `POST /v1/session/login`, `accessToken` y `refreshToken`. Los logs de un dispositivo o de CI los puede leer más gente que quien tiene acceso al dato original.

### Solución

Se implementó `redactForTelemetry` según `docs/CAMPUSOPS_API.md`: recorre objetos y listas sin mutar la entrada, compara la clave normalizada (minúsculas, sin `_` ni `-`) con la lista de claves sensibles y sustituye el valor **completo** por `[REDACTED]`. Conserva campos técnicos como `incidentId`, `status`, `attempt` o `durationMs`. También tolera referencias circulares (`[Circular]`), porque una función de log que lanza una excepción convierte un diagnóstico en una caída.

### Antes

```ts
export function redactForTelemetry(_input: unknown): unknown {
  return pending('redactForTelemetry');
}
```

### Después (núcleo)

```ts
function redact(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(normalizeKey(key)) ? REDACTED : redact(item, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}
```

Ejemplo con datos ficticios (es la primera prueba negativa):

```text
entrada: { actorId: 'reporter-1', role: 'reporter', accessToken: 'demo-access-token-123', refreshToken: 'demo-refresh-token-456', expiresIn: 60 }
salida:  { actorId: 'reporter-1', role: 'reporter', accessToken: '[REDACTED]',              refreshToken: '[REDACTED]',               expiresIn: 60 }
```

### Evidencia

Prueba en rojo antes, en verde después, ejecutadas con `npm test -- --ci --runInBand --verbose src/course-evaluation/redactForTelemetry.test.ts course-tests/public/week-04.test.ts`:

| Momento | Resultado |
|---|---|
| Antes (stub) | `Tests: 15 failed, 15 total` |
| Después | `Tests: 15 passed, 15 total` (14 pruebas negativas mías + la prueba pública de la semana 4) |

Además `npm run typecheck` y `npm run lint` terminan con código 0, `npm run check:architecture` sigue pasando y el caso "observable error context is sanitized" de `course-tests/public/week-10.test.ts` pasa (el otro caso de ese archivo depende de otra función pendiente, `reduceRemoteResponses`, de una semana posterior). Transcripciones: [antes](evidence/logs-sanitizados-antes.txt) y [después](evidence/logs-sanitizados-despues.txt). Las pruebas usan también las incidencias reales del repositorio en memoria del proyecto: comprueban que `tech-123` y las etiquetas de ubicación no aparecen en la salida.

### Límites de esta corrección

- Es por clave, no por contenido: un token dentro de un texto libre (`message`, `title`, `description`) **no se detecta**. Por ejemplo, el título "Falla eléctrica en Aula 302" repite parte de la ubicación y `redactForTelemetry` lo conserva.
- Compara claves exactas: `myToken` no coincide con `token`. Sigo la lista de la especificación del curso, no la amplié.
- Solo protege si se usa: todavía no hay un logger que la llame. Como recomendación de siguiente paso, una regla ESLint `no-console` en `src/` obligaría a pasar por ella.

---

## Hallazgo 4 — Credenciales fijas y CORS abierto en el backend didáctico (no corregido)

### Problema encontrado

En `course-backend/server.mjs` y `course-backend/campusops.mjs` los tokens `course-valid-token` y `course-refresh-0` están escritos en el código (por ejemplo `campusops.mjs:30` y `:33`, `server.mjs:46` y `:58`), y `server.mjs:12` responde `access-control-allow-origin: *`.

### Riesgo

Es exactamente el patrón "credencial escrita en el código": todos los usuarios comparten el mismo token y cualquier persona con el repositorio lo conoce. Con CORS abierto, si el servidor escuchara fuera de `127.0.0.1` (se puede cambiar con `COURSE_BACKEND_HOST`), cualquier página web podría leer sus respuestas.

### Decisión: riesgo aceptado, no corregido

No lo modifiqué por tres razones verificables: (1) el propio archivo lo declara ("Public, in-memory teaching fixture. Never deploy as institutional authentication.", `campusops.mjs:1`) y `docs/CAMPUSOPS_API.md` los llama "fixtures públicos, no secretos"; (2) esos valores forman parte del contrato del curso: los usan el servidor, los autotests, el README del backend y la documentación de la API; (3) es código del curso, no del equipo, y cambiar los valores en el servidor exigiría modificar también sus autotests, que los tienen escritos. Condiciones que sí cumplo: el servidor escucha por defecto solo en `127.0.0.1`, el código de la app (`src/`, `App.tsx`) no contiene ninguno de esos tokens, y no reutilizaré estos valores en un backend real. Si el backend fuera propio, el arreglo correcto sería emitir tokens distintos por sesión y restringir el origen CORS a una lista permitida.

### Evidencia

[fixture-credenciales-cors.txt](evidence/fixture-credenciales-cors.txt) (ubicaciones exactas de cada valor y la lista de archivos que los usan).

---

## Revisado sin hallazgo

| Categoría de la guía | Qué revisé | Resultado |
|---|---|---|
| A. Credenciales en el código | `git grep` de claves, tokens y contraseñas en `src/`, `App.tsx`; `git log --all -G` con patrones de secretos; el escáner `scan_secrets` del evaluador | La app solo usa `EXPO_PUBLIC_COURSE_BACKEND_URL` (una URL local, sin credenciales) desde `process.env`. Lo único fijo son los fixtures del hallazgo 4. |
| B. Información sensible en consola | `git grep -n "console\."` en `src/`, `App.tsx`, `index.ts` | Ninguno. Ver hallazgo 3. |
| C. Datos personales almacenados | Búsqueda de `AsyncStorage`, `localStorage`, `SecureStore`, `MMKV`, `sessionStorage` | La app no guarda nada localmente. Los `evidence/week-XX/individual.json` incluyen matrículas porque el contrato de evidencia del curso las exige (`docs/EVIDENCE_CONTRACT.md`); no guardan nombres ni correos. Riesgo aceptado por requisito del curso y no las reproduje en este documento. |
| D. Información sensible en mensajes de error | Todos los `throw new Error` de `src/` y las respuestas de `course-backend/` | Solo dos mensajes en `src/api/courseBackend.ts`: `Backend health failed with <código HTTP>` y `Backend health contract mismatch`. El backend responde códigos genéricos (`unauthorized`, `invalid_request`), sin URLs ni credenciales. |
| E. Archivos sensibles hacia el repositorio | `.env` en disco, en el índice y en el historial de todas las ramas | No existe, no está rastreado y nunca se agregó. Solo `.env.example` está rastreado. Falla parcial corregida en el hallazgo 1. |
| CI | Los cuatro workflows | Todos declaran `permissions: contents: read` y no usan secretos. Los workflows de las semanas 1, 2 y 3 suben `reports/**` y `evidence/**` como artefactos; eso incluye las matrículas de los `individual.json`, que son requisito del curso. |

## Comprobación final

Resultado de ejecutar las comprobaciones de la Parte 9 (transcripción completa en [comprobacion-final.txt](evidence/comprobacion-final.txt)):

- `.env` y sus variantes: no aparecen en `git status`, ni en el índice, ni en el historial de ninguna rama; solo `.env.example` está rastreado.
- Escáner de secretos del evaluador (`scan_secrets`) sobre el árbol de trabajo: sin coincidencias.
- Sin matrículas, correos institucionales ni rutas locales en `docs/security-audit.md` ni en `docs/evidence/`.

## Limitaciones de esta entrega

- La evidencia son transcripciones de terminal (`.txt`) generadas con los comandos reales, no capturas de pantalla; cada archivo incluye el comando, la fecha y el código de salida.
- El primer `npm run test:smoke` tras editar archivos falló por tiempo (caché en frío, 47 s) y pasó al repetirlo (8 s), comportamiento ya conocido en esta máquina; no fue un fallo de aserción.
- Los `.DS_Store` siguen en el historial y las pruebas de `redactForTelemetry` no cubren texto libre (ver límites del hallazgo 3).
