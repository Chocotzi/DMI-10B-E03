import { redactForTelemetry } from './index';
import { incidentRepository } from '../campusops/infrastructure/InMemoryIncidentRepository';

const REDACTED = '[REDACTED]';

function leaks(output: unknown, values: readonly string[]): string[] {
  const text = JSON.stringify(output);
  return values.filter((value) => text.includes(value));
}

describe('redactForTelemetry: pruebas negativas de fuga de datos', () => {
  it('no filtra tokens de una respuesta de sesión', () => {
    const response = {
      actorId: 'reporter-1',
      role: 'reporter',
      accessToken: 'demo-access-token-123',
      refreshToken: 'demo-refresh-token-456',
      expiresIn: 60,
    };
    const output = redactForTelemetry(response);
    expect(leaks(output, ['demo-access-token-123', 'demo-refresh-token-456'])).toEqual([]);
    expect(output).toEqual({
      actorId: 'reporter-1',
      role: 'reporter',
      accessToken: REDACTED,
      refreshToken: REDACTED,
      expiresIn: 60,
    });
  });

  it('no filtra técnico asignado ni ubicación de las incidencias del repositorio', async () => {
    const incidents = await incidentRepository.getAll();
    const sensitive = incidents.flatMap((incident) => [
      incident.location.label,
      incident.work.assignedTechnicianId ?? '',
    ]).filter((value) => value !== '');
    expect(sensitive.length).toBeGreaterThan(0);

    const output = redactForTelemetry(incidents);
    expect(leaks(output, sensitive)).toEqual([]);
    expect(output).toEqual(
      incidents.map((incident) => ({
        ...incident,
        location: REDACTED,
        work: { assignedTechnicianId: REDACTED, status: incident.work.status },
      })),
    );
  });

  it.each(['access_token', 'Access-Token', 'REFRESH_TOKEN', 'Assigned-Technician-Id', 'display_name', 'Internal_Comments'])(
    'redacta la clave %s sin importar mayúsculas ni separadores',
    (key) => {
      expect(redactForTelemetry({ [key]: 'valor-ficticio', attempt: 1 })).toEqual({ [key]: REDACTED, attempt: 1 });
    },
  );

  it('conserva el contexto técnico no sensible', () => {
    const technical = { incidentId: 'campus-inc-001', correlationId: 'corr-1', status: 'open', attempt: 2, durationMs: 35 };
    expect(redactForTelemetry(technical)).toEqual(technical);
  });

  it('reemplaza el valor completo aunque sea un objeto o una lista', () => {
    const input = { location: { latitude: 1, longitude: 2 }, photos: ['foto-ficticia-1'] };
    expect(redactForTelemetry(input)).toEqual({ location: REDACTED, photos: REDACTED });
  });

  it('recorre listas y objetos anidados', () => {
    const input = {
      items: [{ id: 'a', email: 'persona@campusops.test' }, { id: 'b', meta: { password: 'demo-pass' } }],
    };
    expect(redactForTelemetry(input)).toEqual({
      items: [{ id: 'a', email: REDACTED }, { id: 'b', meta: { password: REDACTED } }],
    });
  });

  it('no muta la entrada', () => {
    const input = { token: 'demo-token', nested: { email: 'persona@campusops.test' } };
    const snapshot: unknown = JSON.parse(JSON.stringify(input));
    redactForTelemetry(input);
    expect(input).toEqual(snapshot);
  });

  it('no se cae con referencias circulares y sigue redactando', () => {
    const circular: { id: string; token: string; self?: unknown } = { id: 'x', token: 'demo-token' };
    circular.self = circular;
    expect(redactForTelemetry(circular)).toEqual({ id: 'x', token: REDACTED, self: '[Circular]' });
  });

  it('deja pasar valores primitivos', () => {
    expect(redactForTelemetry('texto')).toBe('texto');
    expect(redactForTelemetry(42)).toBe(42);
    expect(redactForTelemetry(null)).toBeNull();
    expect(redactForTelemetry(undefined)).toBeUndefined();
  });
});
