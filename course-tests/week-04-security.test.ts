import { redactForTelemetry } from '../src/security/redactForTelemetry';
import {
  clearSecureSession,
  getSecureSession,
  safeErrorMessage,
  setSecureSession,
} from '../src/security/secureSession';

afterEach(() => clearSecureSession());

test('sanitizes nested objects and lists without mutating the input', () => {
  const input = {
    incidentId: 'campus-inc-001',
    status: 'open',
    request: { headers: { authorization: 'Bearer fictional-token' } },
    records: [
      { email: 'reporter@fictional.test', location: { latitude: 19.4, longitude: -99.1 } },
    ],
  };

  const result = redactForTelemetry(input);

  expect(result).toEqual({
    incidentId: 'campus-inc-001',
    status: 'open',
    request: { headers: { authorization: '[REDACTED]' } },
    records: [{ email: '[REDACTED]', location: '[REDACTED]' }],
  });
  expect(input.records[0]?.email).toBe('reporter@fictional.test');
  expect(JSON.stringify(result)).not.toContain('fictional-token');
  expect(JSON.stringify(result)).not.toContain('19.4');
});

test('keeps session tokens in memory and clears them on logout', () => {
  setSecureSession({ accessToken: 'fictional-access-token', actorId: 'reporter-1', expiresAt: 1 });
  expect(getSecureSession()).toEqual({
    accessToken: 'fictional-access-token',
    actorId: 'reporter-1',
    expiresAt: 1,
  });
  clearSecureSession();
  expect(getSecureSession()).toBeNull();
});

test('returns a generic error without exposing technical details', () => {
  const result = safeErrorMessage(new Error('token=fictional-access-token at location 19.4'));
  expect(result).toBe('No fue posible completar la operación.');
  expect(result).not.toContain('fictional-access-token');
  expect(result).not.toContain('19.4');
});
