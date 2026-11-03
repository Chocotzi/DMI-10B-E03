import { selectIncidentLocation } from '../../course-evaluation';
import type { IncidentLocation } from '../contracts';
import type {
  GeocodingUnavailableCode,
  LocationCache,
  LocationProvider,
} from '../domain/LocationProvider';

/**
 * Week 09 — decides the location attached to an incident.
 *
 * Order (docs/resilience-policy.md §Proveedor de ubicación y caché):
 *   1. Fresh cache entry (age < ttlMs)      → use it, no network call.
 *   2. Provider answers and the answer is valid per `selectIncidentLocation`
 *                                            → use it and store it in the cache.
 *   3. Provider unavailable (timeout/429/5xx/network) and a stale cache entry
 *      younger than maxStaleMs exists        → use the stale entry.
 *   4. Anything else                        → the manual label typed by the
 *      person, with NO invented coordinates.
 *
 * The incident is never blocked: the manual location is always a valid outcome.
 */
export type LocationOrigin = 'cache' | 'provider' | 'stale_cache' | 'manual';

export type ManualReason =
  | GeocodingUnavailableCode
  /** The provider answered, but with null / incomplete / out-of-range data. */
  | 'rejected_by_validation'
  | 'empty_query';

export type ResolvedLocation = Readonly<{
  location: IncidentLocation;
  origin: LocationOrigin;
  /** Present only when origin is 'manual' or 'stale_cache': why the provider was not used. */
  reason?: ManualReason;
}>;

export type ResolveLocationOptions = Readonly<{
  /** How long a cached result is served without asking the provider. Default 24 h. */
  ttlMs?: number;
  /** How old a cached result may be and still replace an unavailable provider. Default 7 days. */
  maxStaleMs?: number;
  now?: () => number;
  /** Defaults to the course-graded `selectIncidentLocation`; injectable only for isolation tests. */
  select?: typeof selectIncidentLocation;
}>;

export const DEFAULT_LOCATION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOCATION_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Case/whitespace-insensitive key so "Edificio  A" and "edificio a" share one entry. */
export function normalizeLocationQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-MX');
}

export class ResolveIncidentLocationUseCase {
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => number;
  private readonly select: typeof selectIncidentLocation;

  constructor(
    private readonly provider: LocationProvider,
    private readonly cache: LocationCache,
    options: ResolveLocationOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_LOCATION_TTL_MS;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_LOCATION_MAX_STALE_MS;
    this.now = options.now ?? Date.now;
    this.select = options.select ?? selectIncidentLocation;
  }

  async execute(query: string, manualLabel: string): Promise<ResolvedLocation> {
    if (manualLabel.trim().length === 0) {
      throw new Error('ResolveIncidentLocationUseCase: manualLabel must be non-empty (it is the guaranteed fallback).');
    }
    const manual = (reason: ManualReason): ResolvedLocation => ({
      location: { source: 'manual', label: manualLabel },
      origin: 'manual',
      reason,
    });

    const key = normalizeLocationQuery(query);
    if (key.length === 0) return manual('empty_query');

    const now = this.now();
    const cached = await this.cache.get(key);
    const age = cached ? now - cached.storedAt : Number.POSITIVE_INFINITY;
    const asLocation = (c: NonNullable<typeof cached>): IncidentLocation => ({
      source: 'provider', label: c.label, latitude: c.latitude, longitude: c.longitude,
    });

    if (cached && age >= 0 && age < this.ttlMs) {
      return { location: asLocation(cached), origin: 'cache' };
    }

    const lookup = await this.provider.lookup(query);
    if (lookup.kind === 'answered') {
      const selected = this.select(lookup.raw, manualLabel);
      if (selected.source === 'provider'
        && selected.latitude !== undefined && selected.longitude !== undefined) {
        await this.cache.put(key, {
          label: selected.label,
          latitude: selected.latitude,
          longitude: selected.longitude,
          storedAt: now,
        });
        return { location: selected, origin: 'provider' };
      }
      // The provider DID answer, with bad data: do not prefer an old cache
      // entry over the person's own label, and do not cache the bad answer.
      return manual('rejected_by_validation');
    }

    if (cached && age >= 0 && age < this.maxStaleMs) {
      return { location: asLocation(cached), origin: 'stale_cache', reason: lookup.code };
    }
    return manual(lookup.code);
  }
}
