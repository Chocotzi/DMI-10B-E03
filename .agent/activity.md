# Tarea por hacer esta semana — CampusOps

Este archivo define las instrucciones, criterios de aceptación y la **división de trabajo en 3 personas** para garantizar que los integrantes trabajen en paralelo sin colisiones ni interferencias, asegurando una entrega completa y auditable.

---

# Semana 10 — Estados de interfaz y observabilidad segura (8 puntos)

Cambiar de incidencia mientras llegan respuestas atrasadas no debe mostrar información de la selección anterior. Esta semana harán que la interfaz de CampusOps represente lo que realmente está ocurriendo y ayude a recuperarse de los errores.

Trabajen en su **equipo de 3**, sobre el mismo repositorio de CampusOps con **React Native, Expo y TypeScript**.

## ¿Qué deben hacer en general?

1. **Definan los estados de la interfaz.** Representen carga, éxito, vacío, error y cancelación, además de desconexión, cambios pendientes y conflictos. Dibujen las transiciones y qué acción puede realizar el usuario en cada estado.
2. **Apliquen los estados a consulta y atención.** Implementen navegación coherente, mensajes y etiquetas accesibles, reintento controlado y recuperación. La app no debe mostrar una espera permanente cuando ya conoce el resultado o no tiene conexión.
3. **Prueben respuestas fuera de orden.** Conecten `reduceRemoteResponses` con la lógica real. Reproduzcan una respuesta antigua que llega después de cambiar la selección: no debe reemplazar la incidencia activa ni producir un estado imposible.
4. **Registren sólo contexto seguro.** Usen identificadores sintéticos de correlación para relacionar un error con su solicitud. Prueben la sanitización: no registren tokens, nombres, ubicación, fotografías o comentarios internos. Documenten qué señal permite diagnosticar sin exponer esos datos.

## ¿Qué se entrega?

En el repositorio deben quedar el código, las pruebas y estos documentos/reportes:

- `docs/ui-state-machine.mmd`: Diagrama de estados y transiciones de la interfaz en Mermaid.
- `reports/week-10/ui-tests.json`: Pruebas de estados, navegación, accesibilidad y respuestas obsoletas.
- `reports/week-10/log-sanitization.json`: Comprobaciones del contexto técnico registrado y de la exclusión de datos sensibles.
- `evidence/week-10/engineering.json`: Justificación de la decisión técnica, alternativas y trade-offs.
- `evidence/week-10/individual.json`: Evidencia individual verificable de los 3 integrantes.

Entrega final: **Enlace del repositorio, etiqueta `week-10-final` y SHA completo**.

---

# División de Trabajo en 3 Personas (Sin interferencias)

Para evitar conflictos de merge en Git y asegurar que cada integrante tenga una aportación técnica sustantiva y evaluable bajo la rúbrica (AC-01 a AC-05), el trabajo se divide en 3 áreas completamente ortogonales y delimitadas por archivos:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                             EQUIPO DMI-10B-E03                           │
├─────────────────────┬────────────────────────────┬───────────────────────┤
│    INTEGRANTE 1     │        INTEGRANTE 2        │      INTEGRANTE 3     │
│   (UI, FSM y A11y)  │ (Respuestas Obsoletas/Red) │ (Observabilidad/Logs) │
│                     │                            │                       │
│ • docs/ui-state-    │ • src/course-evaluation/   │ • src/security/       │
│   machine.mmd       │   index.ts                 │   redactForTelemetry  │
│ • src/campusops/ui/ │ • course-tests/week-10-    │ • course-tests/week-  │
│   List & Detail     │   remote-responses.test.ts │   10-telemetry.test.ts│
│ • reports/week-10/  │ • evidence/week-10/        │ • reports/week-10/    │
│   ui-tests.json     │   engineering.json         │   log-sanitization    │
└─────────────────────┴────────────────────────────┴───────────────────────┘
```

---

## 👤 Integrante 1: Estados de Interfaz, Máquina de Estados (FSM) y Accesibilidad
**Identificador sugerido:** `a3523110321` (o integrante asignado a Frontend / UX)  
**Rama recomendada:** `feat/ui-state-machine-a11y`

### 1. Responsabilidad y Objetivo
Modelar formalmente todos los estados de la interfaz móvil (carga, éxito, vacío, error, cancelación, sin conexión, cambios pendientes y conflicto) y reflejarlos en las pantallas de React Native con etiquetas accesibles para lectores de pantalla y opciones de recuperación/reintento.

### 2. Archivos exclusivos bajo su responsabilidad
- `docs/ui-state-machine.mmd`: Diagrama de estados en Mermaid con transiciones y acciones de usuario.
- `src/campusops/ui/IncidentListScreen.tsx`: Renderizado accesible de estados (indicador de carga, estado vacío explícito, banner offline, badges de pendiente/conflicto y botón de reintento).
- `src/campusops/ui/IncidentDetailScreen.tsx`: Etiquetas de accesibilidad (`accessibilityLabel`, `accessibilityRole`), botón de cancelar operación y mensajes de error recuperables.
- `reports/week-10/ui-tests.json`: Sección de pruebas de renderizado de estados y accesibilidad.

### 3. Tareas técnicas paso a paso
1. **Crear `docs/ui-state-machine.mmd`:**
   - Definir los estados: `Idle`, `Loading`, `Success`, `Empty`, `ErrorRecoverable`, `Cancelled`, `OfflineNotice`, `PendingSync`, `ConflictDetected`.
   - Mapear acciones de transición: `cargar`, `exito_con_datos`, `exito_sin_datos`, `fallo_red`, `reintentar`, `cancelar`, `detectar_offline`.
2. **Actualizar Pantallas en `src/campusops/ui/`:**
   - Agregar `accessibilityRole="header"`, `accessibilityLabel="Lista de incidencias"`, etc.
   - Asegurarse de que si se cancela o no hay conexión, la pantalla muestre de inmediato el estado correspondiente y no una espera infinita (`ActivityIndicator`).
3. **Generar pruebas de UI:**
   - Registrar en `reports/week-10/ui-tests.json` las observaciones de renderizado (estados nominales, de frontera y de fallo).

### 4. Comandos de verificación personal
```bash
npm run typecheck
npm run lint
npm run test:smoke
npm test -- --ci --runInBand course-tests/week-05-ui.test.tsx
```

### 5. Datos para su bloque en `evidence/week-10/individual.json`
- **Archivos:** `["docs/ui-state-machine.mmd", "src/campusops/ui/IncidentListScreen.tsx", "src/campusops/ui/IncidentDetailScreen.tsx", "reports/week-10/ui-tests.json"]`
- **Predicción:** "La UI debe representar de inmediato estados de carga, vacío, cancelación y error recuperable con accesibilidad sin dejar spinners perpetuos."
- **Comando:** `npm run test:smoke && npx jest course-tests/week-05-ui.test.tsx`
- **Resultado observado:** "Componentes montan correctamente con etiquetas accesibles y manejo de reintento."
- **Explicación:** "Diseñé el diagrama FSM de interfaz y apliqué los estados y roles de accesibilidad en los componentes de React Native."

---

## 👤 Integrante 2: Respuestas Fuera de Orden y Algoritmo de Reducción
**Identificador sugerido:** `a3523110227` (o integrante asignado a Core / Lógica de Dominio)  
**Rama recomendada:** `feat/remote-responses-reduction`

### 1. Responsabilidad y Objetivo
Implementar y conectar la función `reduceRemoteResponses` en `src/course-evaluation/index.ts` para resolver el problema de respuestas retrasadas/obsoletas cuando el usuario cambia rápidamente de selección, evitando que datos antiguos reemplacen la incidencia activa. Redactar además la justificación técnica de ingeniería.

### 2. Archivos exclusivos bajo su responsabilidad
- `src/course-evaluation/index.ts`: Implementación de `reduceRemoteResponses`.
- `course-tests/week-10-remote-responses.test.ts`: Suite de pruebas unitarias que simula respuestas fuera de orden (ej. Respuesta de incidencia A que llega después de haber seleccionado B).
- `evidence/week-10/engineering.json`: Redacción de la decisión de arquitectura sobre descarte de respuestas obsoletas, alternativas consideradas y trade-offs.

### 3. Tareas técnicas paso a paso
1. **Implementar `reduceRemoteResponses` en `src/course-evaluation/index.ts`:**
   - Firma requerida:
     ```ts
     export function reduceRemoteResponses(input: Readonly<{
       activeRequestId: string;
       responses: readonly RemoteResponse[];
     }>): Readonly<{ state: 'success' | 'error' | 'loading'; value?: unknown; error?: string }>
     ```
   - Lógica: Filtrar las respuestas que coincidan con `activeRequestId`. Si no hay respuesta para la petición activa, retornar `state: 'loading'`. Si hay respuesta exitosa, retornar `state: 'success', value`. Si hay error, retornar `state: 'error', error`. Ignorar cualquier respuesta atrasada de solicitudes anteriores.
2. **Crear pruebas automatizadas:**
   - Probar que `course-tests/public/week-10.test.ts` pase al 100%.
   - Crear `course-tests/week-10-remote-responses.test.ts` cubriendo casos de carga, respuesta tardía, error en solicitud activa y respuesta duplicada.
3. **Elaborar `evidence/week-10/engineering.json`:**
   - Describir la decisión de reducción funcional de estados de red vs. cancelación agresiva de promesas.
   - Vincular con requisitos AC-01 a AC-04.

### 4. Comandos de verificación personal
```bash
npm test -- --ci --runInBand course-tests/public/week-10.test.ts
npm test -- --ci --runInBand course-tests/week-10-remote-responses.test.ts
```

### 5. Datos para su bloque en `evidence/week-10/individual.json`
- **Archivos:** `["src/course-evaluation/index.ts", "course-tests/week-10-remote-responses.test.ts", "evidence/week-10/engineering.json"]`
- **Predicción:** "Una respuesta obsoleta con requestId distinto a la selección activa debe descartarse sin sobreescribir el estado de la incidencia seleccionada."
- **Comando:** `npm test -- --ci --runInBand course-tests/public/week-10.test.ts`
- **Resultado observado:** "Prueba pública de semana 10 aprobada; reduceRemoteResponses mantiene el estado correspondiente a activeRequestId."
- **Explicación:** "Implementé el reductor de respuestas asíncronas para garantizar idempotencia en la presentación ante respuestas fuera de orden."

---

## 👤 Integrante 3: Observabilidad Segura, Correlación Sintética y Sanitización
**Identificador sugerido:** `a3523110609` (o integrante asignado a Seguridad y Auditoría)  
**Rama recomendada:** `feat/safe-observability-telemetry`

### 1. Responsabilidad y Objetivo
Garantizar la observabilidad técnica del sistema sin vulnerar la privacidad: implementar identificadores de correlación sintética (`correlationId`) para rastrear errores y verificar exhaustivamente que `redactForTelemetry` y los logs del sistema no filtren tokens, nombres, ubicaciones GPS, fotografías ni notas internas.

### 2. Archivos exclusivos bajo su responsabilidad
- `src/security/redactForTelemetry.ts`: Asegurar la normalización estricta y redacción de campos sensibles para eventos de telemetría y diagnóstico.
- `src/security/safeLogger.ts` (o módulo de diagnóstico técnico seguro): Generador de contexto estructurado `{ correlationId, status, attempt, durationMs, error }`.
- `course-tests/week-10-telemetry.test.ts`: Pruebas de exclusión de datos personales y verificación de identificadores de correlación.
- `reports/week-10/log-sanitization.json`: Reporte formal de comprobaciones de contexto técnico seguro y sanitización.

### 3. Tareas técnicas paso a paso
1. **Reforzar sanitización de telemetría:**
   - Validar que al registrar errores de red o excepciones, las trazas y objetos pasen por `redactForTelemetry`.
   - Garantizar que los campos `correlationId`, `attempt`, `status` y `code` se conserven para permitir diagnóstico sin exponer PII.
2. **Crear pruebas de seguridad en `course-tests/week-10-telemetry.test.ts`:**
   - Evaluar objetos anidados con `accessToken`, `email`, `location`, `internalComments` y comprobar que se sustituyen por `[REDACTED]`.
   - Comprobar que `npm run check:secrets` no detecta patrones prohibidos.
3. **Completar `reports/week-10/log-sanitization.json`:**
   - Incluir los checks formales requeridos con `scenarioType` (`nominal`, `boundary`, `failure`).

### 4. Comandos de verificación personal
```bash
npm run check:secrets
npm test -- --ci --runInBand course-tests/week-10-telemetry.test.ts
npm test -- --ci --runInBand course-tests/public/week-10.test.ts
```

### 5. Datos para su bloque en `evidence/week-10/individual.json`
- **Archivos:** `["src/security/redactForTelemetry.ts", "course-tests/week-10-telemetry.test.ts", "reports/week-10/log-sanitization.json"]`
- **Predicción:** "La telemetría técnica debe conservar correlationId e información de error pero ocultar el 100% de datos sensibles normalizados."
- **Comando:** `npm test -- --ci --runInBand course-tests/week-10-telemetry.test.ts && npm run check:secrets`
- **Resultado observado:** "Los logs sustituyen claves sensibles por [REDACTED] y el escáner de secretos pasa limpio."
- **Explicación:** "Validé y documenté los controles de observabilidad segura, asegurando correlación sintética sin fuga de datos sensibles."

---

## Protocolo de Integración y Entrega Final

Una vez que cada integrante ha probado su rama de forma aislada:

1. **Merge de ramas a `dev-cleber` (o rama común de integración):**
   - Integrar Rama 1, luego Rama 2 y finalmente Rama 3. Al estar divididos por archivos, no habrá conflictos de merge.
2. **Consolidar `evidence/week-10/individual.json`:**
   - Reunir los 3 registros individuales con sus respectivos commits de autoría.
3. **Ejecutar el pipeline de verificación completo:**
   ```bash
   make verify
   npm run check:architecture
   npm run check:secrets
   make public-test-week-10
   make verify-week-10
   ```
4. **Congelar la versión con Tag y Reporte de Fallas:**
   ```bash
   git add evidence/ reports/ docs/
   git commit -m "docs(week-10): complete week 10 deliverables and evidence"
   git tag -a week-10-final -m "DMI week 10 final"
   make evidence-week-10
   git push origin <rama>
   git push origin week-10-final
   ```
5. **Comprobación en Classroom:**
   - URL del repositorio.
   - Tag: `week-10-final`.
   - SHA completo de 40 caracteres obtenido con `git rev-list -n 1 week-10-final`.
