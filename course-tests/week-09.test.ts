import {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPT,
  RETRY_MAX_DELAY_MS,
  planRetry,
  selectIncidentLocation,
} from '../src/course-evaluation';

const MANUAL = 'Edificio B, planta baja';
const manual = { source: 'manual', label: MANUAL } as const;
const KEY = 'resolve-campus-inc-001-op-1';

type RetryInput = Parameters<typeof planRetry>[0];

describe('Week 09 - Retry policy & location selection (Carlos)', () => {
  describe('selectIncidentLocation', () => {
    it('accepts a complete provider result and returns only the contract fields', () => {
      const result = selectIncidentLocation(
        { label: 'Laboratorio de redes', latitude: 18.4614, longitude: -97.3923, extra: 'ignorar', accuracy: 5 },
        MANUAL,
      );
      expect(result).toEqual({
        source: 'provider', label: 'Laboratorio de redes', latitude: 18.4614, longitude: -97.3923,
      });
      expect(Object.keys(result).sort()).toEqual(['label', 'latitude', 'longitude', 'source']);
    });

    it('accepts the exact range limits and zero coordinates', () => {
      for (const [latitude, longitude] of [[90, 180], [-90, -180], [0, 0], [-0, -0]]) {
        expect(selectIncidentLocation({ label: 'Límite', latitude, longitude }, MANUAL)).toEqual({
          source: 'provider', label: 'Límite', latitude, longitude,
        });
      }
    });

    it('trims the provider label', () => {
      expect(selectIncidentLocation({ label: '  Cafetería  ', latitude: 1, longitude: 2 }, MANUAL))
        .toMatchObject({ source: 'provider', label: 'Cafetería' });
    });

    it.each([
      ['latitud > 90', 90.0001, 0],
      ['latitud < -90', -90.0001, 0],
      ['longitud > 180', 0, 180.0001],
      ['longitud < -180', 0, -180.0001],
      ['latitud NaN', Number.NaN, 0],
      ['longitud NaN', 0, Number.NaN],
      ['latitud Infinity', Number.POSITIVE_INFINITY, 0],
      ['longitud -Infinity', 0, Number.NEGATIVE_INFINITY],
    ])('falls back to manual when %s', (_case, latitude, longitude) => {
      expect(selectIncidentLocation({ label: 'Fuera', latitude, longitude }, MANUAL)).toEqual(manual);
    });

    it.each([
      ['coordenadas como texto', { label: 'Texto', latitude: '18.46', longitude: '-97.39' }],
      ['coordenadas booleanas', { label: 'Bool', latitude: true, longitude: false }],
      ['coordenadas null', { label: 'Null', latitude: null, longitude: null }],
      ['coordenadas como objeto Number', { label: 'Boxed', latitude: new Number(1), longitude: new Number(2) }],
      ['falta longitud', { label: 'Incompleta', latitude: 18.46 }],
      ['falta latitud', { label: 'Incompleta', longitude: -97.39 }],
      ['solo etiqueta', { label: 'Incompleta' }],
      ['etiqueta vacía', { label: '', latitude: 1, longitude: 1 }],
      ['etiqueta solo espacios', { label: '   ', latitude: 1, longitude: 1 }],
      ['etiqueta numérica', { label: 42, latitude: 1, longitude: 1 }],
      ['sin etiqueta', { latitude: 1, longitude: 1 }],
    ])('falls back to manual with %s', (_case, provider) => {
      expect(selectIncidentLocation(provider, MANUAL)).toEqual(manual);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['un error representado como dato', { status: 429 }],
      ['un resultado no disponible del adaptador', { kind: 'unavailable', code: 'timeout' }],
      ['una instancia de Error', new Error('network')],
      ['un arreglo', [18.46, -97.39]],
      ['un texto', 'Edificio A'],
      ['un número', 18.46],
    ])('falls back to manual with %s', (_case, provider) => {
      expect(selectIncidentLocation(provider, MANUAL)).toEqual(manual);
    });

    it('never adds coordinates to the manual result and never mutates the input', () => {
      const provider = Object.freeze({ label: 'Inválida', latitude: 91, longitude: 0 });
      const result = selectIncidentLocation(provider, MANUAL);
      expect(result).not.toHaveProperty('latitude');
      expect(result).not.toHaveProperty('longitude');
      expect(provider).toEqual({ label: 'Inválida', latitude: 91, longitude: 0 });
    });
  });

  describe('planRetry', () => {
    it('honors a valid Retry-After for an idempotent GET', () => {
      expect(planRetry({ method: 'GET', status: 429, attempt: 1, retryAfterMs: 800 })).toEqual({
        retry: true, delayMs: 800, requiresStableIdempotencyKey: false,
      });
      expect(planRetry({ method: 'GET', status: 503, attempt: 2, retryAfterMs: 0 })).toEqual({
        retry: true, delayMs: 0, requiresStableIdempotencyKey: false,
      });
      expect(planRetry({ method: 'GET', status: 503, attempt: 1, retryAfterMs: RETRY_MAX_DELAY_MS }))
        .toMatchObject({ retry: true, delayMs: RETRY_MAX_DELAY_MS });
    });

    it('uses bounded exponential backoff without Retry-After', () => {
      const delays = [1, 2, 3].map((attempt) => planRetry({ method: 'GET', status: 'timeout', attempt }).delayMs);
      expect(delays).toEqual([RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2, RETRY_BASE_DELAY_MS * 4]);
    });

    it.each([
      ['negativo', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['mayor al tope de 60 s', RETRY_MAX_DELAY_MS + 1],
      ['texto', '800' as unknown as number],
    ])('ignores an invalid Retry-After (%s) and keeps a finite backoff', (_case, retryAfterMs) => {
      const plan = planRetry({ method: 'GET', status: 429, attempt: 1, retryAfterMs });
      expect(plan).toEqual({ retry: true, delayMs: RETRY_BASE_DELAY_MS, requiresStableIdempotencyKey: false });
      expect(Number.isFinite(plan.delayMs)).toBe(true);
    });

    it('allows attempts 1 to 3 and stops from attempt 4 onwards', () => {
      expect(RETRY_MAX_ATTEMPT).toBe(3);
      for (const attempt of [1, 2, 3]) {
        expect(planRetry({ method: 'GET', status: 503, attempt }).retry).toBe(true);
      }
      for (const attempt of [4, 5, 10, 1000]) {
        expect(planRetry({ method: 'GET', status: 503, attempt, retryAfterMs: 100 })).toEqual({
          retry: false, delayMs: 0, requiresStableIdempotencyKey: false,
        });
      }
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid attempt number (%p)', (attempt) => {
      expect(planRetry({ method: 'GET', status: 503, attempt })).toMatchObject({ retry: false, delayMs: 0 });
    });

    it.each(['timeout', 408, 429, 500, 502, 503, 504] as const)('retries transient status %p', (status) => {
      expect(planRetry({ method: 'GET', status, attempt: 1 }).retry).toBe(true);
    });

    it.each([200, 201, 400, 401, 403, 404, 409, 422, 501, 503.5])('does not retry non-transient status %p', (status) => {
      expect(planRetry({ method: 'GET', status, attempt: 1 })).toEqual({
        retry: false, delayMs: 0, requiresStableIdempotencyKey: false,
      });
    });

    it('retries a POST only when it carries a stable idempotency key', () => {
      expect(planRetry({ method: 'POST', status: 'timeout', attempt: 1, idempotencyKey: KEY })).toEqual({
        retry: true, delayMs: RETRY_BASE_DELAY_MS, requiresStableIdempotencyKey: false,
      });
      expect(planRetry({ method: 'POST', status: 429, attempt: 2, retryAfterMs: 1000, idempotencyKey: KEY }))
        .toEqual({ retry: true, delayMs: 1000, requiresStableIdempotencyKey: false });
    });

    it.each([
      ['sin clave', undefined],
      ['clave vacía', ''],
      ['clave solo espacios', '   '],
      ['clave no textual', 123 as unknown as string],
    ])('never retries a POST %s, even if the failure is transient', (_case, idempotencyKey) => {
      for (const status of ['timeout', 429, 503] as const) {
        expect(planRetry({
          method: 'POST', status, attempt: 1, retryAfterMs: 500,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        })).toEqual({
          retry: false, delayMs: 0, requiresStableIdempotencyKey: true,
        });
      }
    });

    it('keeps the attempt limit for POST with key', () => {
      expect(planRetry({ method: 'POST', status: 503, attempt: 4, idempotencyKey: KEY })).toEqual({
        retry: false, delayMs: 0, requiresStableIdempotencyKey: false,
      });
    });

    it('treats an unknown method as non-idempotent', () => {
      const input = { method: 'PUT', status: 503, attempt: 1 } as unknown as RetryInput;
      expect(planRetry(input)).toEqual({ retry: false, delayMs: 0, requiresStableIdempotencyKey: true });
    });

    it('returns a safe plan for malformed input and does not mutate it', () => {
      expect(planRetry(null as unknown as RetryInput)).toEqual({
        retry: false, delayMs: 0, requiresStableIdempotencyKey: false,
      });
      const input = Object.freeze({ method: 'GET', status: 429, attempt: 1, retryAfterMs: 800 } as const);
      planRetry(input);
      expect(input).toEqual({ method: 'GET', status: 429, attempt: 1, retryAfterMs: 800 });
    });

    it('always returns a finite, non-negative delay', () => {
      for (const method of ['GET', 'POST'] as const) {
        for (const status of ['timeout', 429, 503, 404] as const) {
          for (const attempt of [1, 2, 3, 4]) {
            for (const retryAfterMs of [undefined, 0, 800, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
              const { delayMs } = planRetry({
                method, status, attempt, idempotencyKey: KEY,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              });
              expect(Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= RETRY_MAX_DELAY_MS).toBe(true);
            }
          }
        }
      }
    });
  });
});
