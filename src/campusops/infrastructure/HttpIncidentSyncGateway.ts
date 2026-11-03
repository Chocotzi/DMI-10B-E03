import { parseRemoteResource, planRetry, redactForTelemetry } from '../../course-evaluation';
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
 *
 * Week 09 — every exchange (the POST in `submitAction`, the GET in
 * `fetchSnapshot`) is wrapped with `planRetry`
 * (`src/course-evaluation/index.ts`): a local client timeout and a 408/429/5xx
 * from the server are retried in place, up to `RETRY_MAX_ATTEMPT` additional
 * times, honoring a real `Retry-After` or falling back to progressive
 * backoff, always resending the *same* `Idempotency-Key` on POST. That is how
 * a response the client never saw (`timeout_after_commit`: the server applies
 * the change but the socket is held past the client's own timeout) resolves
 * itself as a replay instead of staying stuck until the next full sync cycle.
 * A disconnection (`network`) and an unreadable 2xx (`invalid_response`) are
 * deliberately NOT retried here: `planRetry` has no verdict for them (no
 * idempotent request was even acknowledged, or its outcome is ambiguous), and
 * immediately hammering a device that has no connection helps no one. Those
 * stay `pending` for `SyncPendingOperationsUseCase`'s own cross-cycle backoff
 * (`nextSyncDelayMs`). See docs/resilience-policy.md §3 for the full policy
 * and `course-tests/week-09-retry-integration.test.ts` for the evidence
 * against the real backend.
 */
export type SyncGatewayOptions = Readonly<{
  baseUrl: string;
  actorId: string;
  accessToken: string;
  timeoutMs?: number;
  /** Public backend variant (`X-Course-Scenario`), only for controlled tests. */
  scenario?: 'success' | 'server_error' | 'rate_limited' | 'slow' | 'malformed' | 'timeout_after_commit';
  fetchImpl?: typeof fetch;
  /**
   * Observes every HTTP attempt (including the first), already sanitized
   * with `redactForTelemetry`. Never receives request/response bodies or
   * headers — only the technical fields `docs/CAMPUSOPS_API.md` allows
   * (`incidentId`, `correlationId`, `status`, `attempt`, `durationMs`).
   */
  onAttempt?: (telemetry: RetryAttemptTelemetry) => void;
  /** Replaces the real wait between retries. Tests inject a fast double; production keeps the default (a real timer). */
  sleepImpl?: (ms: number) => Promise<void>;
}>;

/** One HTTP attempt as it is safe to log, report or send as telemetry. */
export type RetryAttemptTelemetry = Readonly<{
  incidentId: string;
  /** The `Idempotency-Key` in flight, when the attempt is a POST. */
  correlationId?: string;
  method: 'GET' | 'POST';
  attempt: number;
  status: number | 'timeout' | 'network';
  durationMs: number;
  /** What `planRetry` decided right after this attempt. */
  retry: boolean;
  delayMs: number;
}>;

type Exchange =
  | Readonly<{ kind: 'response'; status: number; body: unknown; retryAfter: string | null }>
  | Readonly<{ kind: 'failed'; code: 'timeout' | 'network' }>;

/** What one exchange means for the caller, and whether it is worth retrying. */
type Classification<T> = Readonly<{
  outcome: T;
  /** Set only when this attempt's failure is one `planRetry` can reason about. */
  retryableStatus?: number | 'timeout';
  retryAfterMs?: number;
}>;

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * Performs `run()` once, classifies the result, and — only when
   * `classify` flags the failure as something `planRetry` can evaluate —
   * asks it whether to try again, how long to wait, and stops the moment it
   * says no (success, a non-transient rejection, or the attempt budget is
   * spent). Shared by `submitAction` (POST, with the stable `idempotencyKey`
   * that makes a retried lost response safe) and `fetchSnapshot` (GET, no
   * key needed). Every attempt — retried or not — is reported through
   * `onAttempt`, redacted.
   */
  private async withRetry<T>(
    method: 'GET' | 'POST',
    incidentId: string,
    idempotencyKey: string | undefined,
    run: () => Promise<Exchange>,
    classify: (exchange: Exchange) => Classification<T>,
  ): Promise<T> {
    let attempt = 1;
    for (;;) {
      const startedAt = Date.now();
      const result = await run();
      const durationMs = Date.now() - startedAt;
      const { outcome, retryableStatus, retryAfterMs: hintedDelayMs } = classify(result);

      const plan = retryableStatus === undefined
        ? { retry: false, delayMs: 0 }
        : planRetry({
          method,
          status: retryableStatus,
          attempt,
          ...(hintedDelayMs !== undefined ? { retryAfterMs: hintedDelayMs } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        });

      this.options.onAttempt?.(redactForTelemetry({
        incidentId,
        ...(idempotencyKey !== undefined ? { correlationId: idempotencyKey } : {}),
        method,
        attempt,
        status: retryableStatus ?? (result.kind === 'failed' ? result.code : result.status),
        durationMs,
        retry: plan.retry,
        delayMs: plan.delayMs,
      }) as RetryAttemptTelemetry);

      if (!plan.retry) return outcome;
      await (this.options.sleepImpl ?? defaultSleep)(plan.delayMs);
      attempt += 1;
    }
  }

  private classifySubmit(exchange: Exchange, submission: ActionSubmission): Classification<ActionOutcome> {
    if (exchange.kind === 'failed') {
      return exchange.code === 'timeout'
        ? { outcome: { kind: 'unavailable', code: 'timeout' }, retryableStatus: 'timeout' }
        : { outcome: { kind: 'unavailable', code: 'network' } };
    }
    const { status, body } = exchange;
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : null;
    if (status === 200 || status === 201) {
      const incident = isRecord(body) ? parseRemoteResource(body.incident) : null;
      if (!isRecord(body) || body.operationId !== submission.idempotencyKey
        || typeof body.duplicate !== 'boolean' || !incident?.ok) {
        // A 2xx we cannot read does not prove anything: keep the entry and replay later.
        return { outcome: { kind: 'unavailable', code: 'invalid_response' } };
      }
      return { outcome: { kind: 'applied', duplicate: body.duplicate, version: incident.value.version } };
    }
    if (status === 401) return { outcome: { kind: 'unauthenticated' } };
    if (status === 403) return { outcome: { kind: 'rejected', code: 'forbidden', status } };
    if (status === 408) return { outcome: { kind: 'unavailable', code: 'timeout' }, retryableStatus: 408 };
    if (status === 409) {
      if (code === 'idempotency_key_reused' || code === 'transition_conflict') {
        return { outcome: { kind: 'rejected', code, status } };
      }
      return { outcome: { kind: 'rejected', code: 'version_conflict', status } };
    }
    if (status === 429) {
      const delay = retryAfterMs(exchange.retryAfter);
      return {
        outcome: delay !== undefined
          ? { kind: 'unavailable', code: 'rate_limited', retryAfterMs: delay }
          : { kind: 'unavailable', code: 'rate_limited' },
        retryableStatus: 429,
        ...(delay !== undefined ? { retryAfterMs: delay } : {}),
      };
    }
    if (status >= 500) return { outcome: { kind: 'unavailable', code: 'server' }, retryableStatus: status };
    if (status >= 400) return { outcome: { kind: 'rejected', code: 'invalid', status } };
    return { outcome: { kind: 'unavailable', code: 'invalid_response' } };
  }

  async submitAction(submission: ActionSubmission): Promise<ActionOutcome> {
    if (!nonempty(submission.idempotencyKey) || submission.idempotencyKey.length < 8
      || !nonempty(submission.incidentId) || !nonempty(submission.action)
      || !Number.isSafeInteger(submission.baseVersion)) {
      return { kind: 'rejected', code: 'invalid', status: 0 };
    }
    return this.withRetry<ActionOutcome>(
      'POST',
      submission.incidentId,
      submission.idempotencyKey,
      () => this.exchange(`/v1/incidents/${encodeURIComponent(submission.incidentId)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.idempotencyKey },
        // Same content on every retry: the server fingerprints it with the key.
        body: JSON.stringify({ ...submission.payload, action: submission.action, baseVersion: submission.baseVersion }),
      }),
      (exchange) => this.classifySubmit(exchange, submission),
    );
  }

  private classifySnapshot(exchange: Exchange): Classification<SnapshotOutcome> {
    if (exchange.kind === 'failed') {
      return exchange.code === 'timeout'
        ? { outcome: { kind: 'unavailable', code: 'timeout' }, retryableStatus: 'timeout' }
        : { outcome: { kind: 'unavailable', code: 'network' } };
    }
    if (exchange.status === 401) return { outcome: { kind: 'unavailable', code: 'unauthenticated' } };
    if (exchange.status === 403 || exchange.status === 404) return { outcome: { kind: 'forbidden' } };
    if (exchange.status === 408) return { outcome: { kind: 'unavailable', code: 'timeout' }, retryableStatus: 408 };
    if (exchange.status === 429) {
      const delay = retryAfterMs(exchange.retryAfter);
      return {
        outcome: { kind: 'unavailable', code: 'rate_limited' },
        retryableStatus: 429,
        ...(delay !== undefined ? { retryAfterMs: delay } : {}),
      };
    }
    if (exchange.status >= 500) return { outcome: { kind: 'unavailable', code: 'server' }, retryableStatus: exchange.status };
    if (exchange.status !== 200) return { outcome: { kind: 'unavailable', code: 'invalid_response' } };

    const parsed = parseRemoteResource(exchange.body);
    if (!parsed.ok || parsed.value.payload === null || !statuses.includes(parsed.value.status as IncidentStatus)) {
      return { outcome: { kind: 'unavailable', code: 'invalid_response' } };
    }
    const { id, version, status, payload } = parsed.value;
    const assigned = payload.assignedTechnicianId;
    if (!(assigned === null || nonempty(assigned))) return { outcome: { kind: 'unavailable', code: 'invalid_response' } };
    const history = Array.isArray(payload.history) ? payload.history : [];
    return {
      outcome: {
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
      },
    };
  }

  async fetchSnapshot(incidentId: string): Promise<SnapshotOutcome> {
    if (!nonempty(incidentId)) return { kind: 'unavailable', code: 'invalid_response' };
    return this.withRetry<SnapshotOutcome>(
      'GET',
      incidentId,
      undefined,
      () => this.exchange(`/v1/incidents/${encodeURIComponent(incidentId)}`, { method: 'GET' }),
      (exchange) => this.classifySnapshot(exchange),
    );
  }
}
