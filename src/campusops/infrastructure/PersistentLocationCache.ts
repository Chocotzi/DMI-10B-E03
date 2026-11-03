import type { CachedLocation, LocationCache } from '../domain/LocationProvider';
import type { KeyValueStorage } from './PersistentOperationQueueRepository';

/** Schema version of the persisted geocoding cache; see docs/resilience-policy.md. */
export const GEOCODING_CACHE_STORAGE_KEY = 'campusops.geocodingCache.v1';

/** Upper bound of entries kept on the device; oldest `storedAt` is evicted first. */
export const GEOCODING_CACHE_MAX_ENTRIES = 50;

type Persisted = Record<string, CachedLocation>;

function isCachedLocation(value: unknown): value is CachedLocation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.label === 'string' && v.label.trim().length > 0
    && typeof v.latitude === 'number' && Number.isFinite(v.latitude) && v.latitude >= -90 && v.latitude <= 90
    && typeof v.longitude === 'number' && Number.isFinite(v.longitude) && v.longitude >= -180 && v.longitude <= 180
    && typeof v.storedAt === 'number' && Number.isFinite(v.storedAt);
}

/**
 * Geocoding cache that survives app restarts, written through the same
 * `KeyValueStorage` port as the offline queue (Week 08). A corrupted or
 * tampered entry on disk is ignored, never served: the persisted value is
 * re-checked on every read.
 */
export class PersistentLocationCache implements LocationCache {
  private readonly storageKey: string;
  private readonly maxEntries: number;

  constructor(
    private readonly storage: KeyValueStorage,
    options?: Readonly<{ storageKey?: string; maxEntries?: number }>,
  ) {
    this.storageKey = options?.storageKey ?? GEOCODING_CACHE_STORAGE_KEY;
    this.maxEntries = options?.maxEntries ?? GEOCODING_CACHE_MAX_ENTRIES;
  }

  private async readAll(): Promise<Persisted> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(this.storageKey);
    } catch {
      return {};
    }
    if (raw === null || raw === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const clean: Persisted = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isCachedLocation(value)) clean[key] = value;
      }
      return clean;
    } catch {
      return {};
    }
  }

  async get(queryKey: string): Promise<CachedLocation | null> {
    const all = await this.readAll();
    return Object.hasOwn(all, queryKey) ? all[queryKey] ?? null : null;
  }

  async put(queryKey: string, value: CachedLocation): Promise<void> {
    if (!isCachedLocation(value)) return;
    const all = await this.readAll();
    all[queryKey] = value;
    const keys = Object.keys(all).sort((a, b) => (all[a]?.storedAt ?? 0) - (all[b]?.storedAt ?? 0));
    while (keys.length > this.maxEntries) {
      const oldest = keys.shift();
      if (oldest !== undefined) delete all[oldest];
    }
    await this.storage.setItem(this.storageKey, JSON.stringify(all));
  }
}
