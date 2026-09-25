import { getBackendHealth } from '../src/api/courseBackend';
import { redactForTelemetry } from '../src/course-evaluation';

describe('controles de seguridad de la semana 4', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('elimina secretos y datos personales anidados sin modificar el objeto original', () => {
    const input = {
      request: {
        headers: {
          authorization: 'Bearer ficticio-para-pruebas',
          accept: 'application/json',
        },
      },
      profile: {
        email: 'persona@ejemplo.test',
        display_name: 'Persona Ficticia',
      },
      incidentId: 'INC-FICTICIO-001',
      location: { label: 'Ubicacion ficticia' },
      attempts: [{ status: 'retry', apiKey: 'clave-ficticia' }],
    };

    expect(redactForTelemetry(input)).toEqual({
      request: {
        headers: {
          authorization: '[REDACTED]',
          accept: 'application/json',
        },
      },
      profile: {
        email: '[REDACTED]',
        display_name: '[REDACTED]',
      },
      incidentId: 'INC-FICTICIO-001',
      location: '[REDACTED]',
      attempts: [{ status: 'retry', apiKey: '[REDACTED]' }],
    });
    expect(input.profile.email).toBe('persona@ejemplo.test');
  });

  test.each([
    ['una respuesta HTTP fallida', { ok: false, status: 503, json: jest.fn() }],
    ['un contrato inesperado', { ok: true, status: 200, json: jest.fn().mockResolvedValue({ ok: false }) }],
  ])('devuelve un error publico generico ante %s', async (_scenario, response) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response as unknown as Response);

    await expect(getBackendHealth('https://servicio-ficticio.test')).rejects.toThrow(
      'El servicio no está disponible',
    );
    await expect(getBackendHealth('https://servicio-ficticio.test')).rejects.not.toThrow(/503|contract/i);
  });
});
