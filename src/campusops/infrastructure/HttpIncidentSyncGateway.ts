import { parseRemoteResource } from '../../course-evaluation';
import type { IncidentStatus } from '../contracts';
import type {
  ActionOutcome,
  ActionSubmission,
  IncidentSyncGateway,
  SnapshotOutcome,
} from '../domain/IncidentSyncGateway';

/**
 * HTTP adapter of `IncidentSyncGateway` for the didactic backend
 * (`POST /v1/incidents/:id/actions`, `GET /v1/incidents/:id`), see
 * docs/CAMPUSOPS_API.md. It never logs bodies or headers: they can contain
 * assignments, notes and evidence references.
 */
export type SyncGatewayOptions = Readonly<{
  baseUrl: string;
  actorId: string;
  accessToken: string;
  timeoutMs?: number;
  /** Public backend variant (`X-Course-Scenario`), only for controlled tests. */
  scenario?: 'success' | 'server_error' | 'rate_limited' | 'slow' | 'malformed' | 'timeout_after_commit';
  fetchImpl?: typeof fetch;
}>;

type Exchange =
  | Readonly<{ kind: 'response'; status: number; body: unknown; retryAfter: string | null }>
  | Readonly<{ kind: 'failed'; code: 'timeout' | 'network' }>;

const statuses: readonly IncidentStatus[] = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class HttpIncidentSyncGateway implements IncidentSyncGateway {
  constructor(private readonly options: SyncGatewayOptions) {}

  private async exchange(path: string, init: Readonly<{
    method: 'GET' | 'POST';
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }>): Promise<Exchange> {
    const timeoutMs = this.options.timeoutMs ?? 1000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('request_timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async (): Promise<Exchange> => {
        const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
          method: init.method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'X-Course-Actor': this.options.actorId,
            ...(this.options.scenario ? { 'X-Course-Scenario': this.options.scenario } : {}),
            ...init.headers,
          },
          ...(init.body !== undefined ? { body: init.body } : {}),
        });
        let body: unknown = null;
        try {
          body = await response.json() as unknown;
        } catch {
          body = undefined;
        }
        const header = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null;
        return { kind: 'response', status: response.status, body, retryAfter: header };
      })()]);
    } catch (error) {
      const timedOut = controller.signal.aborted || (error instanceof Error && error.message === 'request_timeout');
      return { kind: 'failed', code: timedOut ? 'timeout' : 'network' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async submitAction(submission: ActionSubmission): Promise<ActionOutcome> {
    if (!nonempty(submission.idempotencyKey) || submission.idempotencyKey.length < 8
      || !nonempty(submission.incidentId) || !nonempty(submission.action)
      || !Number.isSafeInteger(submission.baseVersion)) {
      return { kind: 'rejected', code: 'invalid', status: 0 };
    }
    const exchange = await this.exchange(`/v1/incidents/${encodeURIComponent(submission.incidentId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.idempotencyKey },
      // Same content on every retry: the server fingerprints it with the key.
      body: JSON.stringify({ ...submission.payload, action: submission.action, baseVersion: submission.baseVersion }),
    });
    if (exchange.kind === 'failed') return { kind: 'unavailable', code: exchange.code };
    const { status, body } = exchange;
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : null;
    if (status === 200 || status === 201) {
      const incident = isRecord(body) ? parseRemoteResource(body.incident) : null;
      if (!isRecord(body) || body.operationId !== submission.idempotencyKey
        || typeof body.duplicate !== 'boolean' || !incident?.ok) {
        // A 2xx we cannot read does not prove anything: keep the entry and replay later.
        return { kind: 'unavailable', code: 'invalid_response' };
      }
      return { kind: 'applied', duplicate: body.duplicate, version: incident.value.version };
    }
    if (status === 401) return { kind: 'unauthenticated' };
    if (status === 403) return { kind: 'rejected', code: 'forbidden', status };
    if (status === 409) {
      if (code === 'idempotency_key_reused' || code === 'transition_conflict') {
        return { kind: 'rejected', code, status };
      }
      return { kind: 'rejected', code: 'version_conflict', status };
    }
    if (status === 429) {
      const delay = retryAfterMs(exchange.retryAfter);
      return delay !== undefined
        ? { kind: 'unavailable', code: 'rate_limited', retryAfterMs: delay }
        : { kind: 'unavailable', code: 'rate_limited' };
    }
    if (status >= 500) return { kind: 'unavailable', code: 'server' };
    if (status >= 400) return { kind: 'rejected', code: 'invalid', status };
    return { kind: 'unavailable', code: 'invalid_response' };
  }

  async fetchSnapshot(incidentId: string): Promise<SnapshotOutcome> {
    if (!nonempty(incidentId)) return { kind: 'unavailable', code: 'invalid_response' };
    const exchange = await this.exchange(`/v1/incidents/${encodeURIComponent(incidentId)}`, { method: 'GET' });
    if (exchange.kind === 'failed') return { kind: 'unavailable', code: exchange.code };
    if (exchange.status === 401) return { kind: 'unavailable', code: 'unauthenticated' };
    if (exchange.status === 403 || exchange.status === 404) return { kind: 'forbidden' };
    if (exchange.status === 429) return { kind: 'unavailable', code: 'rate_limited' };
    if (exchange.status >= 500) return { kind: 'unavailable', code: 'server' };
    if (exchange.status !== 200) return { kind: 'unavailable', code: 'invalid_response' };

    const parsed = parseRemoteResource(exchange.body);
    if (!parsed.ok || parsed.value.payload === null || !statuses.includes(parsed.value.status as IncidentStatus)) {
      return { kind: 'unavailable', code: 'invalid_response' };
    }
    const { id, version, status, payload } = parsed.value;
    const assigned = payload.assignedTechnicianId;
    if (!(assigned === null || nonempty(assigned))) return { kind: 'unavailable', code: 'invalid_response' };
    const history = Array.isArray(payload.history) ? payload.history : [];
    return {
      kind: 'visible',
      snapshot: {
        id,
        version,
        fields: {
          work: { assignedTechnicianId: assigned, status },
          ...(typeof payload.priority === 'string' ? { priority: payload.priority } : {}),
          ...(typeof payload.diagnosis === 'string' ? { diagnosis: payload.diagnosis } : {}),
        },
        appliedOperationIds: history
          .map((entry: unknown) => (isRecord(entry) ? entry.operationId : undefined))
          .filter(nonempty),
      },
    };
  }
}
