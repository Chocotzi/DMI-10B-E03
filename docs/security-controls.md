# Controles de seguridad y privacidad - Semana 4

## Alcance y amenazas

La revisión cubre la sesión de CampusOps, los registros técnicos y los errores que podrían conservar tokens, nombres, correos, ubicaciones, fotografías o comentarios internos. Todos los valores usados en las pruebas son ficticios.

| Control | Amenaza relacionada | Implementación | Comprobación |
| --- | --- | --- | --- |
| Sesión sólo en memoria | Exposición de token en preferencias o archivos | `src/security/secureSession.ts` conserva la sesión únicamente durante la ejecución, permite limpiarla al cerrar sesión y no escribe en disco. | `course-tests/week-04-security.test.ts` verifica almacenamiento y limpieza. |
| Sanitización profunda | Exposición de datos personales en logs o reportes | `src/security/redactForTelemetry.ts` recorre objetos y listas, sustituye campos sensibles y conserva contexto técnico. | La prueba verifica anidamiento, listas e inmutabilidad. |
| Errores genéricos | Filtración de tokens, coordenadas o detalles internos en mensajes | `safeErrorMessage` devuelve mensajes seguros y no reutiliza el texto técnico de la excepción. | La prueba negativa confirma que el detalle no aparece. |

## Decisión de almacenamiento

Se eligió almacenamiento en memoria para la sesión de este starter educativo. Es preferible a `AsyncStorage` o a un archivo local porque el token no queda persistido después de cerrar o reiniciar la aplicación. La sesión se copia al establecerla y se elimina explícitamente con `clearSecureSession`.

La alternativa de usar un almacén nativo seguro como Expo SecureStore ofrecería persistencia protegida y sería la opción para una aplicación real que necesite mantener la sesión. No se agrega aquí porque el starter no incluye esa dependencia ni requiere persistencia de sesión para sus contratos. La alternativa de almacenamiento plano se descartó porque expone tokens a copias de seguridad, inspección local o sincronización accidental.

## Riesgo residual

Un proceso comprometido podría leer la memoria mientras la aplicación está ejecutándose. Además, la implementación no rota tokens ni reemplaza un gestor de secretos del backend. En producción se debe usar el almacén seguro nativo del sistema, aplicar expiración y rotación, y evitar que el backend acepte roles enviados por el cliente.

## Pruebas negativas

Las pruebas usan estructuras anidadas y listas para confirmar que `authorization`, `email` y `location` se reemplazan por `[REDACTED]` sin modificar la entrada original. También prueban que los errores devuelvan un mensaje genérico y que una sesión limpiada no pueda recuperarse.
