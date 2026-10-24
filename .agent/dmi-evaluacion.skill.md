---
name: dmi-evaluacion
description: Evalúa entregas de proyectos DMI con evidencia verificable, aplicando RUBRIC_PUBLIC.md y una escala de 8 puntos para AC-01 a AC-05.
---

# Evaluación de proyectos DMI

Usa estas instrucciones al evaluar una entrega de proyecto DMI. Basa cada juicio en evidencia comprobable del repositorio, los artefactos entregados y los resultados de las comprobaciones. No infieras cumplimiento a partir de declaraciones sin respaldo.

## Fuentes y reglas de evaluación

- Lee `RUBRIC_PUBLIC.md` del proyecto antes de asignar niveles o puntos. Respeta sus descriptores de desempeño y límites de calificación, aunque una entrega parezca cumplir un criterio de manera informal.
- Usa la consigna y los criterios de aceptación AC-01 a AC-05 aplicables a esa entrega. No inventes criterios ni supongas el contenido de un AC que no esté disponible.
- Evalúa con datos ficticios. No introduzcas datos personales o reales en pruebas, ejemplos, capturas o reportes.
- Conserva las pruebas existentes y su configuración habilitada. No elimines, desactives, omitas ni debilites pruebas para obtener un resultado favorable.
- Un flag solicita corroboración adicional. Por sí mismo, no descuenta puntos ni demuestra una falla. Busca evidencia que lo confirme o descarte y explica el resultado.
- El nivel parcial no tiene un porcentaje prefijado. Asigna los puntos parciales según la evidencia y los límites descritos en `RUBRIC_PUBLIC.md`; no uses una conversión porcentual automática.
- Distingue entre evidencia observada, inferencia y falta de evidencia. Si una comprobación no puede ejecutarse, registra la limitación y no la presentes como aprobada.

## Ponderación

La calificación suma un máximo de **8 puntos**:

| Criterio | Puntos máximos | Evidencia que se debe revisar |
|---|---:|---|
| Reproducción | 2.5 | Si otra persona puede reproducir la entrega siguiendo los pasos y requisitos publicados. Contrasta instrucciones, entorno, datos ficticios y resultados observables. |
| Funcionamiento requerido | 2.0 | Cumplimiento de los comportamientos y requisitos de la consigna, usando los AC correspondientes y evidencia de ejecución o inspección. |
| Manejo de la falla | 1.5 | Respuesta ante los errores, límites o fallas relevantes para la consigna; verifica el comportamiento observado y su recuperación o comunicación. |
| Decisión justificada | 1.5 | Justificación de decisiones con relación al problema, evidencia y restricciones del proyecto; distingue argumentos documentados de afirmaciones sin sustento. |
| Aportación individual | 0.5 | Evidencia atribuible de la contribución individual, conforme a lo que la consigna y `RUBRIC_PUBLIC.md` permitan evaluar. No atribuyas trabajo basándote únicamente en nombres o declaraciones. |
| **Total** | **8.0** | |

La evidencia se organiza además por criterios de aceptación: **AC-01 a AC-03 son comprobaciones automáticas y suman 6 puntos; AC-04 y AC-05 son comprobaciones semiautomáticas y suman 2 puntos.** Consulta `RUBRIC_PUBLIC.md` y la definición de los AC para identificar los puntos y niveles aplicables a cada comprobación. No inventes una correspondencia entre AC y categorías de la tabla si los documentos del proyecto no la especifican.

## Procedimiento

1. **Reúne las fuentes.** Identifica la consigna, `RUBRIC_PUBLIC.md`, definiciones de AC-01 a AC-05, instrucciones para reproducir la entrega y artefactos presentados.
2. **Prepara el entorno con cuidado.** Sigue las instrucciones del proyecto. Usa datos ficticios y conserva intactas las pruebas y sus ajustes. Registra los comandos y las condiciones relevantes para reproducir los resultados.
3. **Revisa AC-01 a AC-03.** Ejecuta las comprobaciones automáticas existentes según las instrucciones del proyecto. Registra comandos, resultados, fallas y limitaciones. No cambies el código ni la configuración de pruebas para silenciar un resultado.
4. **Corrobora AC-04 y AC-05.** Realiza las comprobaciones semiautomáticas especificadas, identifica qué observaste y conserva referencias a los artefactos o pasos que respaldan la conclusión.
5. **Examina flags.** Para cada flag, busca evidencia adicional pertinente. Registra si quedó corroborado, descartado o sin resolver; no apliques una penalización automática por su presencia.
6. **Asigna niveles y puntos.** Aplica los descriptores y límites de `RUBRIC_PUBLIC.md` a la evidencia de cada criterio. Explica cualquier puntuación parcial y evita porcentajes prefijados para el nivel parcial.
7. **Presenta el resultado.** Separa evidencia, conclusión y limitaciones. Incluye las referencias exactas a archivos, secciones, comandos o resultados que permitan revisar cada juicio.

## Registro mínimo de evidencia

Para cada criterio o AC, registra:

- **Comprobación:** criterio o AC evaluado.
- **Método:** archivo inspeccionado, comando ejecutado o paso manual realizado.
- **Resultado observado:** salida o comportamiento concreto, sin adornar ni completar información ausente.
- **Referencia:** ruta y sección, resultado de comando o artefacto relevante.
- **Conclusión:** nivel según `RUBRIC_PUBLIC.md` y breve justificación.
- **Puntos:** puntos asignados y máximo aplicable.
- **Limitación o flag:** qué quedó sin comprobar y qué corroboración se buscó.

## Formato del reporte

### Resumen

- **Puntaje:** __ / 8
- **Estado general:** según los niveles definidos en `RUBRIC_PUBLIC.md`
- **Limitaciones que afectan la evaluación:** ninguna / describir

### Desglose

| Criterio o AC | Nivel según la rúbrica | Puntos | Evidencia y justificación |
|---|---|---:|---|
| Reproducción | | / 2.5 | |
| Funcionamiento requerido | | / 2.0 | |
| Manejo de la falla | | / 1.5 | |
| Decisión justificada | | / 1.5 | |
| Aportación individual | | / 0.5 | |
| **Total** | | **/ 8.0** | |

Incluye también el resultado de **AC-01, AC-02, AC-03, AC-04 y AC-05**, indicando cuáles fueron automáticos y cuáles semiautomáticos, sus evidencias y cualquier limitación. Evita contar dos veces la misma evidencia al sumar los puntos.

### Flags y corroboración

Por cada flag: describe qué señal generó la solicitud de corroboración, qué evidencia adicional se revisó y si se confirmó, descartó o quedó sin resolver. Indica expresamente que el flag no causó una deducción automática.

### Reproducción

Anota los pasos y comandos necesarios, los requisitos de entorno, los datos ficticios utilizados y el resultado observado. Indica con claridad cualquier paso que no se pudo reproducir.

## Criterio de comunicación

Entrega una evaluación breve y verificable. No otorgues crédito por intención, documentación que contradiga el comportamiento observado o pruebas que fueron desactivadas. No declares una falla por un flag sin corroboración. Cuando falte evidencia, di qué falta y qué comprobación concreta permitiría resolverlo.