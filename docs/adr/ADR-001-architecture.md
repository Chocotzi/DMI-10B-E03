# ADR-001: Clean Architecture for CampusOps

## Context
Necesitamos organizar el código de CampusOps permitiendo testabilidad sin backend, separando las responsabilidades de UI, Application, Domain, e Infrastructure.

## Decision
Utilizar Clean Architecture dividida en carpetas: `ui`, `application`, `domain`, e `infrastructure`. Esto asegura la inversión de dependencias.

## Alternativa
Se consideró usar un patrón MVC tradicional en donde los controladores llaman directamente a APIs o un único estado global (Zustand/Redux) que tuviera responsabilidades de UI y lógica de red.

## Consecuencia
El trade-off es que requiere un mayor número de archivos (boilerplate) inicialmente, pero a cambio desacopla las capas, permitiéndonos construir con un `InMemoryIncidentRepository` (infraestructura fake) sin depender de un servicio externo en esta fase del proyecto.
