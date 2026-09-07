# Definición del problema — CampusOps

## Problema

En el campus ficticio, los reportes de incidencias de infraestructura y servicios
(fallas eléctricas, fugas de agua, equipo de laboratorio dañado, cortes de red,
riesgos de seguridad, mantenimiento pendiente) se levantan hoy por canales
informales: mensajes sueltos, correos y llamadas a la persona que "se sabe que
arregla eso". Como consecuencia no hay folio único, no se sabe en qué estado está
cada reporte ni quién es responsable, se duplican reportes del mismo problema,
otros se pierden, y coordinación de servicios generales no tiene con qué priorizar
ni con qué comprobar que una reparación realmente se hizo.

CampusOps atiende ese problema concentrando el ciclo completo
**reportar → asignar → atender → resolver → cerrar** en una sola aplicación móvil:
cada incidencia tiene folio, estado explícito, responsable asignado, prioridad e
historial con evidencia fotográfica y notas. Importa porque sin trazabilidad la
universidad ficticia no puede medir tiempos de atención, se pierde trabajo del
personal técnico y las mismas fallas se reportan una y otra vez.

## Alcance

El alcance incluido corresponde al **alcance mínimo acumulativo** de
`docs/CAMPUSOPS.md`; es terminal (no se exige completo en la Semana 1) y Android
es la plataforma de referencia.

### Incluye

- Inicio de sesión, cierre y ciclo de sesión seguro para los tres perfiles
  (reportante, técnico, coordinador).
- Lista, detalle y creación de incidencias con categoría, descripción y ubicación
  (edificio / zona / referencia capturada manualmente).
- Asignación y reasignación de técnicos, cambio de prioridad y transiciones de
  estado `open → assigned → in_progress → resolved → closed`, con reapertura a
  `assigned` por coordinación.
- Diagnóstico, notas posteriores y evidencia fotográfica, con acceso según perfil.
- Historial inmutable de cada cambio de estado y de asignación
  (estado origen, estado destino, actor, fecha y hora).
- Operación sin conexión para el técnico: consulta de lo almacenado, cola
  persistente de cambios que sobrevive al reinicio de la app, y sincronización
  con detección del conflicto de reasignación (campo compuesto `work` =
  `{ assignedTechnicianId, status }`) sin pérdida silenciosa de cambios pendientes.
- Idempotencia de reintentos: misma clave de idempotencia con el mismo contenido
  no duplica eventos, evidencias ni notificaciones.
- Un servicio de mapas **o** de geocodificación, con caché y captura manual de
  ubicación como alternativa.
- Estados de interfaz de carga, éxito, vacío, error, cancelación, sin conexión y
  cambio pendiente / conflictivo, con recuperación accesible.
- Registros técnicos sanitizados (sólo ID sintético de incidencia, correlación,
  código de error, número de intento y duración).
- APK Android verificable y distribución interna / privada, con preparación
  documentada para distribución pública.

### No incluye

- Login y pantallas completas **en la Semana 1**: esta semana sólo se delimita el
  caso y se reproduce la línea base; la construcción de la app es de semanas
  posteriores.
- Pagos, chat en tiempo real, IA o reconocimiento de imágenes, panel web
  administrativo completo y publicación obligatoria en tiendas.
- Datos reales de personas, credenciales institucionales, planos sensibles o
  integración con sistemas institucionales reales; todo es campus ficticio con
  cuentas y ubicaciones sintéticas.
- Notificaciones push (extensión voluntaria; si se agrega, no puede impedir
  consultar estados ni exigir permisos al iniciar).
- iOS (extensión voluntaria una vez probado el núcleo Android).
- Navegación turn-by-turn, seguimiento continuo de ubicación, ubicación en
  segundo plano y mapas offline completos.

## Actores y responsabilidades

- **Reportante:** crea la incidencia (categoría, descripción, foto opcional,
  ubicación), consulta el estado de **sus propios** reportes y agrega información
  posterior. No ve incidencias de otras personas ni cambia estados o asignaciones.
  Responsable de que la descripción y la ubicación basten para localizar el
  problema sin contacto adicional.
- **Técnico:** atiende **solo** las incidencias que le fueron asignadas; inicia la
  atención (`assigned → in_progress`), registra diagnóstico, notas y evidencia, y
  marca `resolved`. Puede trabajar sin conexión y sincronizar después. No puede
  modificar una incidencia que ya fue reasignada a otra persona. Responsable de
  dejar evidencia verificable de la resolución (no basta con marcar el estado).
- **Coordinador:** consulta el conjunto de incidencias, fija prioridad, asigna y
  reasigna técnicos, revisa historial y evidencia, cierra (`resolved → closed`) o
  reabre (`resolved` / `closed → assigned`, cuando hay técnico asignado).
  Responsable de que toda incidencia abierta tenga responsable y prioridad, y de
  no cerrar una incidencia sin evidencia de resolución.

La misma app presenta las funciones según el perfil. Ocultar un botón no sustituye
comprobar el permiso en el servicio.

## Flujo principal

1. **Reportar:** el reportante crea la incidencia. Queda en `open` con folio,
   autor, categoría, descripción, ubicación y marca de tiempo; todavía sin técnico
   ni prioridad.
2. **Asignar:** el coordinador revisa la incidencia `open`, fija prioridad
   (`low` / `medium` / `high`) y asigna un técnico. Pasa a `assigned`. Una
   reasignación posterior registra de nuevo actor y momento en el historial.
3. **Atender:** el técnico asignado inicia la atención (`assigned → in_progress`),
   registra diagnóstico y notas / evidencia y, al terminar, marca `resolved`. La
   resolución del técnico **no** cierra la incidencia.
4. **Cerrar:** el coordinador verifica la evidencia de la incidencia `resolved` y
   la cierra (`resolved → closed`), o la reabre a `assigned` si la evidencia es
   insuficiente o el problema persiste. Todo cambio queda en el historial y
   repetir la misma operación (reintento) no duplica eventos.

## Criterios de aceptación verificables

1. **Transiciones de estado válidas.** Dado una incidencia en `open`, cuando un
   técnico intenta pasarla a `in_progress` sin que exista el estado `assigned`
   previo, entonces el sistema rechaza la transición (respuesta `403` / error de
   dominio) y el estado permanece `open`. Solo se permiten
   `open → assigned → in_progress → resolved → closed` y la reapertura
   `resolved` / `closed → assigned`. **Cómo se comprueba:** una tabla de
   transiciones que enumere cada par (origen, destino) con su resultado esperado
   y una prueba que la recorra; ninguna transición fuera de la lista debe
   aceptarse.

2. **Cierre solo por coordinación y con evidencia.** Dado una incidencia en
   `resolved` sin ninguna nota ni evidencia de resolución, cuando el coordinador
   intenta cerrarla, entonces la acción se bloquea indicando "evidencia
   requerida"; y cuando un técnico intenta la transición a `closed`, entonces se
   rechaza por perfil. **Cómo se comprueba:** ejecutar ambas acciones sobre datos
   de prueba y observar que el estado sigue en `resolved` y que el historial no
   registró un cierre.

3. **Historial completo e inmutable.** Dado cualquier cambio de estado o de
   asignación, cuando se consulta el detalle de la incidencia, entonces el
   historial muestra una entrada con `{ estadoOrigen, estadoDestino, actor,
   timestamp }` y las entradas anteriores no se modifican ni se eliminan.
   **Cómo se comprueba:** comparar el historial antes y después de N operaciones;
   debe tener exactamente N entradas nuevas y las previas idénticas byte a byte.

4. **Conflicto de reasignación sin pérdida silenciosa.** Dado que el técnico A
   pasa la incidencia a `in_progress` sin conexión mientras coordinación la
   reasigna al técnico B, cuando la app de A sincroniza, entonces se informa un
   conflicto sobre el campo `work`, se conserva la intención pendiente de A y no
   se sobrescribe la asignación a B; ningún cambio pendiente desaparece sin que la
   persona lo vea. **Cómo se comprueba:** reproducir la secuencia con el doble
   determinista de la materia y observar el estado de la cola y el aviso de
   conflicto (0 operaciones descartadas sin registro).

5. **Idempotencia de reintentos.** Dado un cambio de estado encolado con clave de
   idempotencia `K`, cuando se reintenta el envío con la misma `K` y el mismo
   contenido tras un timeout, entonces el servidor registra un solo evento y la
   cola solo elimina la operación al confirmarse; reutilizar `K` con contenido
   distinto se rechaza como error (`409`). **Cómo se comprueba:** contar eventos,
   evidencias y notificaciones tras el reintento; el conteo debe ser exactamente 1.
