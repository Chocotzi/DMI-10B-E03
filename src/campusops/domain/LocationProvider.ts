/**
 * Week 09 — ports for the third-party location (geocoding) integration.
 *
 * The provider is NOT trusted: whatever it returns is handed over as
 * `unknown` and is only turned into an `IncidentLocation` by
 * `selectIncidentLocation` (src/course-evaluation). The adapter never throws
 * for timeouts, 429, 5xx or disconnections; it reports them as data so the
 * caller can fall back to the manual location the person typed.
 * See docs/resilience-policy.md §Proveedor de ubicación y caché.
 */
export type GeocodingUnavailableCode =
  | 'timeout'
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'unauthenticated'
  | 'invalid_request'
  | 'invalid_response';

export type GeocodingLookup =
  /** The provider answered 2xx with a JSON body. Its shape is NOT validated here. */
  | Readonly<{ kind: 'answered'; raw: unknown }>
  /** No usable answer. `retryAfterMs` is set only when the provider sent a valid Retry-After. */
  | Readonly<{ kind: 'unavailable'; code: GeocodingUnavailableCode; status?: number; retryAfterMs?: number }>;

export interface LocationProvider {
  lookup(query: string): Promise<GeocodingLookup>;
}

/** A provider result that `selectIncidentLocation` already accepted as valid. */
export type CachedLocation = Readonly<{
  label: string;
  latitude: number;
  longitude: number;
  /** Epoch milliseconds when the provider returned it. */
  storedAt: number;
}>;

/**
 * Cache of VALIDATED provider results, keyed by normalized query. Only
 * results accepted by `selectIncidentLocation` may be stored, so an
 * incomplete or invalid answer can never be served later as if it were good.
 */
export interface LocationCache {
  get(queryKey: string): Promise<CachedLocation | null>;
  put(queryKey: string, value: CachedLocation): Promise<void>;
}
