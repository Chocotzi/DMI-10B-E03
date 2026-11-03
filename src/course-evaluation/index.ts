import type {
  AuthEvent,
  JsonObject,
  ParseResult,
  PermissionEvent,
  RemoteResponse,
  SyncRecord,
} from './contracts';
import type { IncidentLocation } from '../campusops/contracts';
import { redactForTelemetry as redactTelemetry } from '../security/redactForTelemetry';

function pending(name: string): never {
  throw new Error(`${name} must be implemented in the assigned week`);
}

export function redactForTelemetry(input: unknown): unknown {
  return redactTelemetry(input);
}

export function parseRemoteResource(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'contract' };
  }
  const resource = input as Record<string, unknown>;
  if (typeof resource.id !== 'string' || !resource.id.trim()
    || !Number.isSafeInteger(resource.version) || (resource.version as number) < 0
    || typeof resource.status !== 'string' || !resource.status.trim()
    || !(resource.payload === null || (
      typeof resource.payload === 'object' && !Array.isArray(resource.payload)
    ))) {
    return { ok: false, error: 'contract' };
  }
  return { ok: true, value: {
    id: resource.id,
    version: resource.version as number,
    status: resource.status,
    payload: resource.payload as Record<string, unknown> | null,
  } };
}

export function coordinateRefresh(events: readonly AuthEvent[]): Readonly<{
  status: 'anonymous' | 'authenticated';
  activeGeneration: number | null;
  refreshCalls: number;
  retriedRequestIds: readonly string[];
  persistedToken: string | null;
}> {
  let status: 'anonymous' | 'authenticated' = 'authenticated';
  let activeGeneration: number | null = 0;
  let refreshCalls = 0;
  let persistedToken: string | null = null;
  const retriedRequestIds: string[] = [];
  let isRefreshing = false;

  for (const event of events) {
    if (event.type === 'logout') {
      status = 'anonymous';
      persistedToken = null;
      activeGeneration = null;
      isRefreshing = false;
    } else if (event.type === 'request401') {
      if (!isRefreshing) {
        refreshCalls++;
        isRefreshing = true;
      }
      if (event.requestId) {
        retriedRequestIds.push(event.requestId);
      }
    } else if (event.type === 'refreshSucceeded') {
      status = 'authenticated';
      isRefreshing = false;
      if (event.generation !== undefined) {
        activeGeneration = event.generation;
      }
      if (event.token) {
        persistedToken = event.token;
      }
    } else if (event.type === 'refreshFailed') {
      status = 'anonymous';
      persistedToken = null;
      activeGeneration = null;
      isRefreshing = false;
    }
  }

  return {
    status,
    activeGeneration,
    refreshCalls,
    retriedRequestIds,
    persistedToken,
  };
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!isDeepEqual(objA[key], objB[key])) return false;
  }
  return true;
}

export function resolveSync(
  base: SyncRecord,
  local: SyncRecord,
  remote: SyncRecord,
): Readonly<{ kind: 'merged'; fields: JsonObject } | { kind: 'conflict'; fields: readonly string[] }> {
  const baseFields = (base && typeof base.fields === 'object' && base.fields !== null) ? base.fields : {};
  const localFields = (local && typeof local.fields === 'object' && local.fields !== null) ? local.fields : {};
  const remoteFields = (remote && typeof remote.fields === 'object' && remote.fields !== null) ? remote.fields : {};

  const allKeys = Array.from(
    new Set([
      ...Object.keys(baseFields),
      ...Object.keys(localFields),
      ...Object.keys(remoteFields),
    ]),
  );

  const conflicts: string[] = [];
  const merged: Record<string, unknown> = {};

  for (const key of allKeys) {
    const valBase = baseFields[key];
    const valLocal = localFields[key];
    const valRemote = remoteFields[key];

    const localChanged = !isDeepEqual(valBase, valLocal);
    const remoteChanged = !isDeepEqual(valBase, valRemote);

    if (localChanged && remoteChanged) {
      if (isDeepEqual(valLocal, valRemote)) {
        if (valLocal !== undefined) {
          merged[key] = valLocal;
        }
      } else {
        conflicts.push(key);
      }
    } else if (localChanged) {
      if (valLocal !== undefined) {
        merged[key] = valLocal;
      }
    } else if (remoteChanged) {
      if (valRemote !== undefined) {
        merged[key] = valRemote;
      }
    } else {
      if (valBase !== undefined) {
        merged[key] = valBase;
      }
    }
  }

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => a.localeCompare(b));
    return {
      kind: 'conflict',
      fields: conflicts,
    };
  }

  return {
    kind: 'merged',
    fields: merged,
  };
}

export function deduplicateOperations<T extends Readonly<{ operationId: string }>>(
  operations: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const op of operations) {
    if (op && typeof op.operationId === 'string' && !seen.has(op.operationId)) {
      seen.add(op.operationId);
      result.push(op);
    }
  }
  return result;
}

/**
 * Week 09 retry budget. Values are part of the published contract and are
 * justified in docs/resilience-policy.md §2 and evidence/week-09/engineering.json.
 */
export const RETRY_MAX_ATTEMPT = 3;
export const RETRY_BASE_DELAY_MS = 500;
/** Same ceiling the HTTP adapter applies to Retry-After (HttpGeocodingClient). */
export const RETRY_MAX_DELAY_MS = 60_000;

const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

type RetryPlan = Readonly<{ retry: boolean; delayMs: number; requiresStableIdempotencyKey: boolean }>;

const NO_RETRY: RetryPlan = Object.freeze({ retry: false, delayMs: 0, requiresStableIdempotencyKey: false });

function isStableIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRetryableStatus(status: unknown): boolean {
  if (status === 'timeout') return true;
  return typeof status === 'number' && Number.isInteger(status) && RETRYABLE_HTTP_STATUS.has(status);
}

function isValidRetryAfter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= RETRY_MAX_DELAY_MS;
}

export function planRetry(input: Readonly<{
  method: 'GET' | 'POST';
  status: number | 'timeout';
  attempt: number;
  retryAfterMs?: number;
  idempotencyKey?: string;
}>): RetryPlan {
  if (typeof input !== 'object' || input === null) return NO_RETRY;

  // Anything that is not a GET is treated as non-idempotent: repeating it
  // without a stable key could duplicate the effect on the server.
  if (input.method !== 'GET' && !isStableIdempotencyKey(input.idempotencyKey)) {
    return { retry: false, delayMs: 0, requiresStableIdempotencyKey: true };
  }

  const { attempt } = input;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPT) return NO_RETRY;
  if (!isRetryableStatus(input.status)) return NO_RETRY;

  const delayMs = isValidRetryAfter(input.retryAfterMs)
    ? input.retryAfterMs
    : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);

  return { retry: true, delayMs, requiresStableIdempotencyKey: false };
}

export function reduceRemoteResponses(_input: Readonly<{
  activeRequestId: string;
  responses: readonly RemoteResponse[];
}>): Readonly<{ state: 'success' | 'error' | 'loading'; value?: unknown; error?: string }> {
  return pending('reduceRemoteResponses');
}

export function reducePermissionLifecycle(
  _events: readonly PermissionEvent[],
): Readonly<{ status: 'available' | 'denied' | 'blocked'; resourceActive: boolean }> {
  return pending('reducePermissionLifecycle');
}

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}

/**
 * Week 09: the only place that decides whether an external location is
 * trustworthy (docs/CAMPUSOPS_API.md). Pure: never throws, never invents
 * coordinates, never copies extra fields from the provider.
 */
export function selectIncidentLocation(provider: unknown, manualLabel: string): IncidentLocation {
  const manual: IncidentLocation = { source: 'manual', label: manualLabel };
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return manual;

  const candidate = provider as Record<string, unknown>;
  const { label, latitude, longitude } = candidate;
  if (typeof label !== 'string' || label.trim().length === 0) return manual;
  if (!isCoordinate(latitude, 90) || !isCoordinate(longitude, 180)) return manual;

  return { source: 'provider', label: label.trim(), latitude, longitude };
}
