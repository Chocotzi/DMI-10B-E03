/** @jest-environment node */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';
import { selectIncidentLocation } from '../src/course-evaluation';
import type { IncidentLocation } from '../src/campusops/contracts';
import {
  HttpGeocodingClient,
  parseRetryAfter,
  type GeocodingScenario,
} from '../src/campusops/infrastructure/HttpGeocodingClient';
import {
  GEOCODING_CACHE_STORAGE_KEY,
  PersistentLocationCache,
} from '../src/campusops/infrastructure/PersistentLocationCache';
import type { KeyValueStorage } from '../src/campusops/infrastructure/PersistentOperationQueueRepository';
import { ResolveIncidentLocationUseCase } from '../src/campusops/application/ResolveIncidentLocationUseCase';
import type { GeocodingLookup, LocationProvider } from '../src/campusops/domain/LocationProvider';

// ---------------------------------------------------------------------------
// Real course backend (controlled double of the third-party provider)
// ---------------------------------------------------------------------------
let backend: ChildProcessWithoutNullStreams;
let baseUrl: string;

beforeAll(async () => {
  backend = spawn(process.execPath, ['course-backend/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' },
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('backend startup timeout')), 5000);
    backend.stdout.once('data', (chunk: Buffer) => {
      clearTimeout(deadline);
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
      else reject(new Error('backend did not publish a port'));
    });
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`backend exited: ${code}`)));
  });
}, 10000);

afterAll(() => {
  backend?.kill();
});

/** Node http-based fetch (jest-node has no global fetch polyfill guarantees); exposes headers.get. */
const localFetch = ((input: string, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
  const connection = request(input, {
    method: init?.method ?? 'GET',
    headers: init?.headers as Record<string, string>,
    signal: init?.signal ?? undefined,
  }, (reply) => {
    const chunks: Buffer[] = [];
    reply.on('data', (chunk: Buffer) => chunks.push(chunk));
    reply.on('end', () => {
      const status = reply.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => {
          const value = reply.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        } },
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      } as unknown as Response);
    });
    reply.on('error', reject);
  });
  connection.on('error', reject);
  connection.end();
})) as typeof fetch;

function client(scenario: GeocodingScenario, timeoutMs = 1000, url = baseUrl) {
  return new HttpGeocodingClient({
    baseUrl: url, actorId: 'reporter-1', accessToken: 'course-valid-token',
    scenario, timeoutMs, fetchImpl: localFetch,
  });
}

describe('Week 09 — HttpGeocodingClient against the controlled provider', () => {
  test('success: returns the raw provider answer (fictitious data, real HTTP)', async () => {
    await expect(client('success').lookup('Edificio A')).resolves.toEqual({
      kind: 'answered', raw: { label: 'Edificio de prueba A', latitude: 0, longitude: 0 },
    });
  });

  test('incomplete and invalid_coordinates are passed through unvalidated (validation is selectIncidentLocation\'s job)', async () => {
    await expect(client('incomplete').lookup('Edificio A')).resolves.toEqual({
      kind: 'answered', raw: { label: 'Zona ficticia' },
    });
    await expect(client('invalid_coordinates').lookup('Edificio A')).resolves.toEqual({
      kind: 'answered', raw: { label: 'Zona ficticia', latitude: 999, longitude: null },
    });
  });

  test('429 is reported as data with the provider Retry-After, never thrown', async () => {
    await expect(client('rate_limited').lookup('Edificio A')).resolves.toEqual({
      kind: 'unavailable', code: 'rate_limited', status: 429, retryAfterMs: 1000,
    });
  });

  test('5xx and malformed bodies are unavailable, not exceptions', async () => {
    await expect(client('server_error').lookup('Edificio A')).resolves.toEqual({
      kind: 'unavailable', code: 'server', status: 500,
    });
    await expect(client('malformed').lookup('Edificio A')).resolves.toEqual({
      kind: 'unavailable', code: 'invalid_response', status: 200,
    });
  });

  test('a real timeout (slow provider, 1200 ms vs 200 ms budget) resolves as timeout within the budget', async () => {
    const started = Date.now();
    await expect(client('slow', 200).lookup('Edificio A')).resolves.toEqual({ kind: 'unavailable', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('disconnection (nothing listening) is reported as network', async () => {
    await expect(client('success', 1000, 'http://127.0.0.1:1').lookup('Edificio A'))
      .resolves.toEqual({ kind: 'unavailable', code: 'network' });
  });

  test('an empty query is rejected locally without any network call', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const local = new HttpGeocodingClient({ baseUrl, actorId: 'reporter-1', accessToken: 't', fetchImpl });
    await expect(local.lookup('   ')).resolves.toEqual({ kind: 'unavailable', code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('parseRetryAfter only yields finite, bounded delays', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(parseRetryAfter('1', now)).toBe(1000);
    expect(parseRetryAfter('Sun, 01 Nov 2026 12:00:05 GMT', now)).toBe(5000);
    for (const bad of [null, undefined, '', '-3', 'soon', '86400', '2026-11-01', 'Sun, 01 Nov 2026 13:00:00 GMT']) {
      expect(parseRetryAfter(bad, now)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Cache + manual fallback (ResolveIncidentLocationUseCase)
// ---------------------------------------------------------------------------
function createFakeDeviceStorage(): KeyValueStorage & { backing: Map<string, string> } {
  const backing = new Map<string, string>();
  return {
    backing,
    getItem: (key) => Promise.resolve(backing.get(key) ?? null),
    setItem: (key, value) => {
      backing.set(key, value);
      return Promise.resolve();
    },
  };
}

function scriptedProvider(...answers: GeocodingLookup[]): LocationProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lookup: (query) => {
      calls.push(query);
      const next = answers.shift();
      if (!next) throw new Error('unexpected provider call');
      return Promise.resolve(next);
    },
  };
}

const VALID = { kind: 'answered', raw: { label: 'Edificio de prueba A', latitude: 0, longitude: 0 } } as const;
const PROVIDER_LOCATION: IncidentLocation = { source: 'provider', label: 'Edificio de prueba A', latitude: 0, longitude: 0 };
const MANUAL: IncidentLocation = { source: 'manual', label: 'Edificio A, planta baja' };

/**
 * Until the team's real `selectIncidentLocation` lands (Week 09, task 2) the
 * course stub throws `pending`. The orchestration below is exercised with the
 * REAL function as soon as it exists; meanwhile with a stand-in that follows
 * the published contract in docs/CAMPUSOPS_API.md, so cache/fallback logic is
 * still verified. The stand-in is never used by production code.
 */
function contractStandIn(provider: unknown, manualLabel: string): IncidentLocation {
  if (typeof provider === 'object' && provider !== null) {
    const p = provider as Record<string, unknown>;
    if (typeof p.label === 'string' && p.label.trim() !== ''
      && typeof p.latitude === 'number' && Number.isFinite(p.latitude) && p.latitude >= -90 && p.latitude <= 90
      && typeof p.longitude === 'number' && Number.isFinite(p.longitude) && p.longitude >= -180 && p.longitude <= 180) {
      return { source: 'provider', label: p.label, latitude: p.latitude, longitude: p.longitude };
    }
  }
  return { source: 'manual', label: manualLabel };
}

const realSelectionReady = (() => {
  try {
    selectIncidentLocation(null, 'x');
    return true;
  } catch {
    return false;
  }
})();

const selectors: readonly [string, typeof selectIncidentLocation | undefined][] = realSelectionReady
  ? [['real selectIncidentLocation', undefined]]
  : [['contract stand-in (real selectIncidentLocation still pending)', contractStandIn]];

describe.each(selectors)('Week 09 — ResolveIncidentLocationUseCase with %s', (_name, select) => {
  const HOUR = 60 * 60 * 1000;
  let clock = Date.parse('2026-11-01T12:00:00Z');
  const now = () => clock;
  const useCase = (provider: LocationProvider, storage: KeyValueStorage) =>
    new ResolveIncidentLocationUseCase(provider, new PersistentLocationCache(storage), {
      now, ttlMs: HOUR, maxStaleMs: 24 * HOUR, ...(select ? { select } : {}),
    });

  beforeEach(() => {
    clock = Date.parse('2026-11-01T12:00:00Z');
  });

  test('valid provider answer is used and cached; the same query (any casing) is then served from cache with no call', async () => {
    const storage = createFakeDeviceStorage();
    const provider = scriptedProvider(VALID);
    const resolve = useCase(provider, storage);

    await expect(resolve.execute('Edificio A', MANUAL.label)).resolves.toEqual({ location: PROVIDER_LOCATION, origin: 'provider' });
    clock += 10 * 60 * 1000;
    await expect(resolve.execute('  edificio   a ', MANUAL.label)).resolves.toEqual({ location: PROVIDER_LOCATION, origin: 'cache' });
    expect(provider.calls).toEqual(['Edificio A']);
  });

  test('the cache survives an app restart (new instances over the same device storage)', async () => {
    const storage = createFakeDeviceStorage();
    await useCase(scriptedProvider(VALID), storage).execute('Edificio A', MANUAL.label);

    const afterRestart = scriptedProvider();
    await expect(useCase(afterRestart, storage).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: PROVIDER_LOCATION, origin: 'cache' });
    expect(afterRestart.calls).toHaveLength(0);
    expect(storage.backing.has(GEOCODING_CACHE_STORAGE_KEY)).toBe(true);
  });

  test.each([
    ['null', null],
    ['incomplete', { label: 'Zona ficticia' }],
    ['invalid coordinates', { label: 'Zona ficticia', latitude: 999, longitude: null }],
    ['wrong types', { label: 42, latitude: '0', longitude: '0' }],
  ])('%s provider data keeps the manual location, invents no coordinates and is NOT cached', async (_label, raw) => {
    const storage = createFakeDeviceStorage();
    const result = await useCase(scriptedProvider({ kind: 'answered', raw }), storage).execute('Edificio A', MANUAL.label);
    expect(result).toEqual({ location: MANUAL, origin: 'manual', reason: 'rejected_by_validation' });
    expect(result.location).not.toHaveProperty('latitude');
    expect(storage.backing.size).toBe(0);
  });

  test.each(['timeout', 'rate_limited', 'server', 'network'] as const)(
    'provider %s without any cache falls back to manual with the reason recorded',
    async (code) => {
      const result = await useCase(scriptedProvider({ kind: 'unavailable', code }), createFakeDeviceStorage())
        .execute('Edificio A', MANUAL.label);
      expect(result).toEqual({ location: MANUAL, origin: 'manual', reason: code });
    },
  );

  test('expired-but-recent cache entry replaces an unavailable provider (stale_cache), and the provider is asked first', async () => {
    const storage = createFakeDeviceStorage();
    await useCase(scriptedProvider(VALID), storage).execute('Edificio A', MANUAL.label);
    clock += 2 * HOUR; // past ttl, within maxStale
    const provider = scriptedProvider({ kind: 'unavailable', code: 'rate_limited', retryAfterMs: 1000 });
    await expect(useCase(provider, storage).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: PROVIDER_LOCATION, origin: 'stale_cache', reason: 'rate_limited' });
    expect(provider.calls).toHaveLength(1);
  });

  test('a cache entry older than maxStale is never served; the manual label wins', async () => {
    const storage = createFakeDeviceStorage();
    await useCase(scriptedProvider(VALID), storage).execute('Edificio A', MANUAL.label);
    clock += 48 * HOUR;
    await expect(useCase(scriptedProvider({ kind: 'unavailable', code: 'timeout' }), storage).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: MANUAL, origin: 'manual', reason: 'timeout' });
  });

  test('a corrupted cache on disk is ignored instead of crashing or being served', async () => {
    const storage = createFakeDeviceStorage();
    storage.backing.set(GEOCODING_CACHE_STORAGE_KEY, JSON.stringify({ 'edificio a': { label: 'X', latitude: 999, longitude: 0, storedAt: clock } }));
    const provider = scriptedProvider({ kind: 'unavailable', code: 'network' });
    await expect(useCase(provider, storage).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: MANUAL, origin: 'manual', reason: 'network' });
  });

  test('empty query goes straight to manual; empty manual label is a programming error', async () => {
    const provider = scriptedProvider();
    await expect(useCase(provider, createFakeDeviceStorage()).execute('  ', MANUAL.label))
      .resolves.toEqual({ location: MANUAL, origin: 'manual', reason: 'empty_query' });
    expect(provider.calls).toHaveLength(0);
    await expect(useCase(provider, createFakeDeviceStorage()).execute('Edificio A', ' ')).rejects.toThrow(/manualLabel/);
  });

  test('end to end with the real HTTP adapter: success is cached, then a 429 provider still yields the cached location', async () => {
    const storage = createFakeDeviceStorage();
    await expect(useCase(client('success'), storage).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: PROVIDER_LOCATION, origin: 'provider' });
    clock += 2 * HOUR;
    await expect(useCase(client('rate_limited'), storage).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: PROVIDER_LOCATION, origin: 'stale_cache', reason: 'rate_limited' });
    await expect(useCase(client('incomplete'), createFakeDeviceStorage()).execute('Edificio A', MANUAL.label))
      .resolves.toEqual({ location: MANUAL, origin: 'manual', reason: 'rejected_by_validation' });
  });
});
