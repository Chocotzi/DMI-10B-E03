import { redactForTelemetry } from '../src/security/redactForTelemetry';

test('T3: la telemetría no expone secretos ni datos sensibles', () => {
  const result = redactForTelemetry({
    authorization: 'Bearer course-token',
    email: 'reporter@example.test',
    location: { latitude: 19.4, longitude: -98.1 },
    incidentId: 'INC-001',
    status: 'open',
  });

  expect(result).toEqual({
    authorization: '[REDACTED]',
    email: '[REDACTED]',
    location: '[REDACTED]',
    incidentId: 'INC-001',
    status: 'open',
  });
  expect(JSON.stringify(result)).not.toContain('course-token');
  expect(JSON.stringify(result)).not.toContain('19.4');
});
