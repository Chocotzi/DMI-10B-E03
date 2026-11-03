import type {
  GeocodingLookup,
  GeocodingUnavailableCode,
  LocationProvider,
} from '../domain/LocationProvider';

/**
 * Week 09 — HTTP adapter for the third-party geocoding provider
 * (`GET /v1/geocoding?q=...`; the course backend acts as a controlled double
 * of the real provider, see docs/CAMPUSOPS_API.md).
 *
 * Contract of this adapter:
 * - It NEVER throws. Timeout, disconnection, 429, 5xx, 401 and unparsable
 *   bodies are returned as `{ kind: 'unavailable', code }`.
 * - It does NOT validate the shape of a 2xx body; that is
 *   `selectIncidentLocation`'s job, so validation lives in one place.
 * - It does NOT retry. Retrying is decided by `planRetry` in the layer that
 *   owns the retry budget (docs/resilience-policy.md).
 * - The query is sent URL-encoded and is never logged.
 */
export type GeocodingScenario =
  | 'success'
  | 'nullable'
  | 'incomplete'
  | 'invalid_coordinates'
  | 'malformed'
  | 'server_error'
  | 'rate_limited'
  | 'slow';

export type GeocodingClientOptions = Readonly<{
  baseUrl: string;
  actorId: string;
  accessToken: string;
  /** Hard deadline for the whole request, body included. Default 1000 ms. */
  timeoutMs?: number;
  scenario?: GeocodingScenario;
  fetchImpl?: typeof fetch;
  /** Injected clock, used only to interpret an HTTP-date Retry-After. */
  now?: () => number;
}>;

/** Longest Retry-After we accept from the provider; anything above is treated as absent. */
export const MAX_RETRY_AFTER_MS = 60_000;

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into a finite,
 * non-negative millisecond delay. Returns `undefined` for missing, negative,
 * non-numeric or absurdly large values so callers never sleep forever.
 */
export function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  if (!nonempty(header)) return undefined;
  const trimmed = header.trim();
  let delayMs: number;
  if (/^\d+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1000;
  } else {
    // Only the IMF-fixdate form (RFC 9110), e.g. "Sun, 01 Nov 2026 12:00:05 GMT".
    // A bare Date.parse would accept things like "-3" (year -3) as a date.
    if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return undefined;
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return undefined;
    delayMs = Math.max(0, at - now);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_RETRY_AFTER_MS) return undefined;
  return delayMs;
}

function unavailable(
  code: GeocodingUnavailableCode,
  extra: Readonly<{ status?: number; retryAfterMs?: number | undefined }> = {},
): GeocodingLookup {
  return {
    kind: 'unavailable',
    code,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
  };
}

function codeForStatus(status: number): GeocodingUnavailableCode {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthenticated';
  if (status >= 500) return 'server';
  return 'invalid_request';
}

export class HttpGeocodingClient implements LocationProvider {
  constructor(private readonly options: GeocodingClientOptions) {}

  async lookup(query: string): Promise<GeocodingLookup> {
    const timeoutMs = this.options.timeoutMs ?? 1000;
    if (!nonempty(query) || !nonempty(this.options.baseUrl) || !nonempty(this.options.actorId)
      || !nonempty(this.options.accessToken) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return unavailable('invalid_request');
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<GeocodingLookup>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(unavailable('timeout'));
      }, timeoutMs);
    });

    const attempt = (async (): Promise<GeocodingLookup> => {
      const url = `${this.options.baseUrl.replace(/\/$/, '')}/v1/geocoding?q=${encodeURIComponent(query.trim())}`;
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'X-Course-Actor': this.options.actorId,
            ...(this.options.scenario ? { 'X-Course-Scenario': this.options.scenario } : {}),
          },
        });
      } catch {
        return unavailable(controller.signal.aborted ? 'timeout' : 'network');
      }
      if (!response.ok) {
        const retryAfterMs = response.status === 429
          ? parseRetryAfter(response.headers?.get?.('retry-after'), (this.options.now ?? Date.now)())
          : undefined;
        return unavailable(codeForStatus(response.status), { status: response.status, retryAfterMs });
      }
      try {
        return { kind: 'answered', raw: await response.json() as unknown };
      } catch {
        return unavailable(controller.signal.aborted ? 'timeout' : 'invalid_response', { status: response.status });
      }
    })();

    try {
      return await Promise.race([deadline, attempt]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
