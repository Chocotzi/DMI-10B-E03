# tarea por hacer esta semana #


este archivo solo es para tratar las instrucciones y los criterios de aceptacion de la actividad por semana existira un directorio donde se encuentren todas las actividades  por semana por un check in completo pero este solo sera de esta semana.

Tu trabajo sera dividir la tarea entre 3 personas para poder entregar todo completo para la respectiva semana y devolver las asignaciones a cada persona por el chat 

Esta es la actividad de esta semana los archivos comprimidos ya se encuentran en el proyecto tienes aun mas contexto en agent/activity/ACTIVITY_STUDENT_FACING.md
 , agent/activity/RUBRIC_PUBLIC.MD , agent/activity/CAMPUSOPS_API.MD y agent/activity/CAMPUSOPS.MD  :





# Semana 08 — Persistencia íntegra y sincronización (8 puntos)

Un técnico inicia una atención sin conexión mientras coordinación reasigna la incidencia. Esta semana CampusOps deberá conservar ambos hechos y detectar el conflicto, sin perder cambios ni imponer una asignación antigua.

Trabajen en su **equipo de 3**, sobre el mismo repositorio de CampusOps con **React Native, Expo y TypeScript**. Descarguen el ZIP `week-08-persistencia-sincronizacion.zip`; no reinicien el proyecto ni borren el trabajo anterior.

## ¿Qué deben hacer?

1. **Definan los datos y la cola local.** Documenten el modelo y almacenen los cambios pendientes con identidad estable, incidencia, versión base y autor. Las notas y referencias a fotografías pendientes deben seguir siendo utilizables después de reiniciar, no sólo mientras la app permanece abierta.
2. **Prueben una migración recuperable.** Comprueben cómo cambia el esquema de datos sin perder información ni la cola. Si falla una transacción, no debe quedar una migración a medias. Demuestren la recuperación o rollback con pruebas aisladas y repetibles.
3. **Detecten el conflicto de reasignación.** Prueben el inicio local de atención frente a la reasignación remota. No sobrescriban la asignación nueva ni descarten la intención pendiente. Justifiquen cómo informarán y resolverán el conflicto. En los adaptadores, work agrupa asignado y estado; eso no obliga a copiar ese modelo en la base de datos.
4. **Sincronicen sin duplicar operaciones.** Integren resolveSync y deduplicateOperations con la aplicación. Combinen cambios independientes, informen los incompatibles y mantengan las entradas originales. Repitan una operación con la misma identidad y demuestren que no duplica el efecto; retiren de la cola sólo lo confirmado.

## ¿Qué entregan?

En el repositorio deben quedar el código, las pruebas y estos documentos/reportes:

- `docs/data-model.md`: Modelo de datos, persistencia y migración de la información y de la cola.
- `docs/sync-policy.md`: Política de sincronización, conflictos, reintentos y conservación de cambios pendientes.
- `reports/week-08/migration-tests.json`: Pruebas de migración, rollback, reinicio, conflicto y operaciones repetidas.

Incluyan también la justificación técnica del equipo y la evidencia de sus tres integrantes en `engineering.json` e `individual.json`, dentro de `evidence/week-08/`.

En esta tarea entreguen **enlace del repositorio, etiqueta `week-08-final` y SHA completo**. La etiqueta señala la versión final y el SHA es su identificador único. `ACTIVITY_STUDENT_FACING.md` explica los pasos y `STARTER_AND_REPOSITORY.md` contiene los comandos y el formato de evidencias.

## ¿Cómo se califica?

Reproducción: **2.5**; funcionamiento requerido: **2**; manejo de la falla: **1.5**; decisión justificada: **1.5**; aportación individual: **0.5**. Total: **8 puntos**. Consulten `RUBRIC_PUBLIC.md` para los niveles de desempeño y límites de calificación. Usen datos ficticios y conserven las pruebas sin desactivarlas.

La calificación se obtiene a partir de evidencia: AC-01 a AC-03 son comprobaciones automáticas (6 puntos) y AC-04/AC-05 son comprobaciones semiautomáticas (2 puntos). El nivel parcial no tiene un porcentaje prefijado: se asigna según la evidencia descrita en la rúbrica. Un flag sólo solicita corroboración y no descuenta por sí mismo.

**Entrega: 26 de octubre de 2026, a las 23:59, hora de Ciudad de México.**

Por separado, cada integrante responde **Quiz semanal 8 — Persistencia y sincronización**: **3 preguntas, 3 puntos**, que no forman parte de los 8 de esta actividad.
