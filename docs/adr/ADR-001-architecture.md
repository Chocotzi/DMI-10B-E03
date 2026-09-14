# ADR-001: Arquitectura interna de CampusOps — Clean Architecture por capas

- **Estado:** aceptada (semana 2, 2026-09-14). Consolida y sustituye la primera versión breve de este ADR escrita en la rama `dev-cleber`.
- **Decisores:** equipo DMI-10B-E03. a3523110321 diseñó e implementó el esqueleto por capas; a3523110227 detectó y corrigió la violación de límites y escribió el checker; a3523110609 integró ambas ramas, consolidó este ADR y el diagrama, e incorporó el checker a `make verify`.
- **Artefactos relacionados:** `docs/architecture.mmd`, `tools/check-architecture.mjs`, `reports/week-02/dependencies.json`, `evidence/week-02/engineering.json`.

## Contexto

CampusOps va a acumular pantallas (lista, detalle, creación), reglas de incidencias (transiciones `open → assigned → in_progress → resolved → closed` y permisos por perfil), sesión (login, refresh y logout para tres perfiles), persistencia local (cola de operaciones pendientes que sobrevive al reinicio) y proveedores externos (backend didáctico `/v1/incidents` y geocodificación con alternativa manual). El stack está fijado (React Native + Expo + TypeScript) y no se vuelve a decidir.

La actividad exige justificar la organización interna según tres criterios: **facilidad de prueba**, **complejidad** y **costo de cambiar un proveedor**. Además, el registro de riesgos de la semana 1 pide que la política de cola y de conflicto de reasignación (Riesgo 1) se pueda probar antes de construir la interfaz, y que la sanitización de datos (Riesgo 2) viva en un solo punto y no en cada pantalla.

## Alternativas consideradas

### Alternativa A — MVC de pantallas: cada pantalla llama servicios y almacenamiento directamente

Las pantallas (`*Screen.tsx`) hacen `fetch` al backend, leen y escriben AsyncStorage y contienen las reglas de estado en sus manejadores. Es el patrón "controlador dentro de la vista" habitual en prototipos.

- Facilidad de prueba: baja. Para probar una regla hay que renderizar la pantalla y sustituir `fetch` y el almacenamiento con `jest.mock`; no existe una unidad que ejercite la regla sin React.
- Complejidad: mínima al inicio (cero cableado), pero crece por duplicación: las mismas reglas y el mismo manejo de errores aparecen en lista, detalle y creación.
- Cambio de proveedor: caro. Pasar del fake en memoria al backend `/v1/incidents`, o cambiar el proveedor de geocodificación, obliga a tocar cada pantalla que lo usa.

### Alternativa B — Estado global único (Zustand o Redux) que concentra interfaz, red y persistencia

Un store global guarda incidencias, sesión y cola; sus acciones hacen las llamadas HTTP y la persistencia. Las pantallas solo leen selectores y despachan acciones.

- Facilidad de prueba: media. Las acciones son funciones probables sin React, pero mezclan reglas de negocio con red y persistencia, así que las pruebas siguen necesitando mocks de `fetch` y del almacenamiento.
- Complejidad: media-alta. Añade una dependencia y un vocabulario propio (slices, selectores, middleware); el store tiende a convertirse en un módulo que concentra lógica de red y de dominio entrelazadas.
- Cambio de proveedor: medio. Se cambia en las acciones del store, pero como no hay un contrato explícito del proveedor, nada garantiza que una implementación alternativa cumpla la misma interfaz.

### Alternativa C — Clean Architecture en cuatro capas con regla de dependencia hacia adentro (elegida)

`ui → application → domain ← infrastructure`, con una raíz de composición (`App.tsx`) que es el único módulo que conoce a la vez los adaptadores concretos y las pantallas.

- Facilidad de prueba: alta. Los casos de uso y las reglas de dominio se prueban con un stub de `IncidentRepository` sin React ni mocks de módulo; las pantallas se prueban pasando un caso de uso falso por props.
- Complejidad: media al inicio (más archivos: entidad, puerto, caso de uso, adaptador, pantalla) y estable después; cada nueva capacidad sigue el mismo molde.
- Cambio de proveedor: barato. Un proveedor nuevo es una clase en `infrastructure/` que implementa el puerto del dominio; se sustituye en una línea de la raíz de composición sin tocar `ui/`, `application/` ni `domain/`.

### Comparación

| Criterio | A. MVC de pantallas | B. Store global | C. Clean Architecture |
|---|---|---|---|
| Facilidad de prueba | Baja: requiere render y mocks de módulo | Media: acciones probables pero acopladas a red y persistencia | Alta: casos de uso y reglas con stubs del puerto |
| Complejidad inicial | Mínima | Media-alta (dependencia y vocabulario propio) | Media (más archivos, un molde repetible) |
| Costo de cambiar proveedor | Alto: cada pantalla | Medio: acciones del store, sin contrato | Bajo: nuevo adaptador y una línea en `App.tsx` |
| Reglas verificables por comando | No | Parcial | Sí: `npm run check:architecture` y test público |

## Decisión

Adoptamos la **Alternativa C**. La estructura ya implementada bajo `src/campusops/` es:

| Capa | Carpeta | Contenido actual | Puede importar de |
|---|---|---|---|
| Domain | `src/campusops/domain/` (más `src/campusops/contracts.ts`) | `Incident` (entidad), `IncidentRepository` (puerto) y el vocabulario público del curso (`IncidentStatus`, `IncidentCategory`, `IncidentWork`, `IncidentLocation`, `PendingIncidentOperation`) | nada (solo de sí misma) |
| Application | `src/campusops/application/` | `GetIncidentsUseCase`, `GetIncidentDetailUseCase` | Domain |
| Infrastructure | `src/campusops/infrastructure/` | `InMemoryIncidentRepository` (fake determinista con datos ficticios) | Domain |
| UI | `src/campusops/ui/` | `IncidentListScreen`, `IncidentDetailScreen`; reciben los casos de uso por props | Application y tipos de Domain |
| Raíz de composición | `App.tsx` (fuera de las capas) | instancia `InMemoryIncidentRepository`, construye los casos de uso y los inyecta en las pantallas | todas |

La regla de dependencia es la que codifica `tools/check-architecture.mjs` en su mapa `forbidden`: `ui` no importa `infrastructure`; `application` no importa `ui` ni `infrastructure`; `domain` no importa ninguna otra capa; `infrastructure` no importa `ui` ni `application`. Se ejecuta con `npm run check:architecture`, forma parte de `make verify` (y por tanto de `make feedback`), y la prueba pública `course-tests/public/week-02.test.ts` comprueba además que el diagrama no declare una arista directa de la interfaz a la infraestructura.

### Límites de responsabilidad para los hitos siguientes

El diagrama marca como *planificado* lo que todavía no tiene código; el molde es el mismo:

- **Incidencias:** ya cubierto por `IncidentRepository` y sus casos de uso. En la semana 5 se añade `HttpIncidentRepository` contra `/v1/incidents` y casos de uso de creación y acciones que validan el sobre `{ id, version, status, payload }` antes de tocar el dominio.
- **Sesión y perfiles:** puerto `SessionRepository` en dominio, casos de uso `Login`, `Logout` y `Refresh` en aplicación y un adaptador de almacenamiento seguro en infraestructura. Los tres perfiles (reportante, técnico, coordinador) usan las mismas pantallas; las reglas de qué puede hacer cada perfil viven en dominio y se vuelven a comprobar en el backend: ocultar un botón no autoriza nada.
- **Persistencia y cola sin conexión:** puerto `PendingOperationQueue` (sobre `PendingIncidentOperation`) y caso de uso `SyncPendingOperations`; la política de conflicto sobre `work` es una regla de dominio que se prueba con el doble determinista antes de construir la interfaz (mitigación del Riesgo 1).
- **Proveedores externos:** puerto `LocationProvider` con adaptador de geocodificación (doble del curso) y captura manual como alternativa; la sanitización de registros técnicos es un único adaptador de infraestructura, no una responsabilidad de las pantallas (Riesgo 2).

## Discrepancia detectada entre el diseño y el código, y su corrección

En el commit `3388cd1` (primera versión del esqueleto) las pantallas importaban directamente el adaptador concreto:

```ts
// src/campusops/ui/IncidentListScreen.tsx en 3388cd1, líneas 5 y 7
import { incidentRepository } from '../infrastructure/InMemoryIncidentRepository';
const getIncidentsUseCase = new GetIncidentsUseCase(incidentRepository);
```

Esto creaba una arista de `ui` hacia `infrastructure` que el diagrama negaba. Efecto: la interfaz quedaba acoplada al fake en memoria, sustituir el proveedor exigía editar cada pantalla y las pantallas no podían probarse con un repositorio de prueba sin `jest.mock` del módulo de infraestructura.

La corrección (`6817fcc`) movió la composición a `App.tsx` y pasó los casos de uso por props (`IncidentListScreen.tsx`, `IncidentDetailScreen.tsx`). `tools/check-architecture.mjs` detecta la versión rota (dos violaciones, código de salida 1) y acepta la corregida. La reproducción y el resultado observado están en `reports/week-02/dependencies.json`.

## Consecuencias (trade-off)

Positivas:

- Las reglas de dependencia son verificables por comando, no solo por lectura del diagrama; una regresión de límites falla en `make verify` y en CI.
- Sustituir un componente es local: un nuevo adaptador implementa el puerto y se cambia una línea en `App.tsx`. Ejemplo previsto: `HttpIncidentRepository implements IncidentRepository`.
- Los casos de uso y las reglas de dominio se prueban sin backend, sin React y sin mocks de módulo, lo que permite escribir primero las pruebas de la cola y del conflicto de reasignación.

Negativas y riesgos aceptados:

- Más archivos y algo de ceremonia por capacidad (entidad, puerto, caso de uso, adaptador, pantalla).
- El paso de casos de uso por props crece con cada pantalla; al introducir navegación (semanas 5 y 10) la composición se moverá a un proveedor en el navegador raíz, manteniendo `App.tsx` como único punto que conoce infraestructura.
- `tools/check-architecture.mjs` es una heurística por segmentos de ruta (`/ui/`, `/infrastructure/`, etc.); no analiza el grafo de módulos real ni alias de importación, así que un *barrel* o un alias podrían eludirla. Se aceptó por su costo cero en dependencias; si aparecen alias se sustituirá por una regla de ESLint de importaciones restringidas.
- Las entidades de dominio son por ahora tipos sin comportamiento; las reglas de transición y permisos se añadirán como funciones puras de dominio cuando lleguen sus hitos, sin cambiar los límites aquí definidos.
