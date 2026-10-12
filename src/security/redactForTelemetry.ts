const SENSITIVE_KEYS = new Set([
  'authorization', 'password', 'token', 'accesstoken', 'refreshtoken',
  'email', 'displayname', 'name', 'userid', 'reporterid', 'technicianid',
  'assignedtechnicianid', 'location', 'latitude', 'longitude', 'photos',
  'evidence', 'internalcomments', 'assignmenthistory',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function redactForTelemetry(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactForTelemetry);
  if (input === null || typeof input !== 'object') return input;

  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    SENSITIVE_KEYS.has(normalizeKey(key)) ? '[REDACTED]' : redactForTelemetry(value),
  ]));
}
