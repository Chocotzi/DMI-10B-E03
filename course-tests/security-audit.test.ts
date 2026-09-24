import { readFileSync } from 'node:fs';
import { logTelemetry } from '../src/security/safeLogger';

test('telemetry logger emits only sanitized details', () => {
  const output = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  logTelemetry('incident.request', {
    incidentId: 'INC-001',
    token: 'course-fixture-token',
    email: 'person@example.test',
    location: 'Zona ficticia',
    status: 'open',
  });

  expect(output).toHaveBeenCalledWith('incident.request', {
    incidentId: 'INC-001',
    token: '[REDACTED]',
    email: '[REDACTED]',
    location: '[REDACTED]',
    status: 'open',
  });
  output.mockRestore();
});

test('.env is ignored and no real env file is tracked', () => {
  expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.env$/m);
  expect(readFileSync('.env.example', 'utf8')).toContain('COURSE_VALID_TOKEN=');
});
