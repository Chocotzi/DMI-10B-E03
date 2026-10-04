import { parseRemoteResource } from '../../course-evaluation';
import type { IncidentCategory, IncidentStatus } from '../contracts';
import type { Incident } from '../domain/Incident';

const categories: readonly IncidentCategory[] = [
  'electrical', 'laboratory', 'water', 'connectivity',
  'equipment', 'safety', 'maintenance',
];
const statuses: readonly IncidentStatus[] = [
  'open', 'assigned', 'in_progress', 'resolved', 'closed',
];

type Failure = Readonly<{
  kind: 'error';
  code: 'invalid_request' | 'invalid_contract' | 'timeout' | 'network' | 'server' | 'http';
  status?: number;
}>;
export type ClientResult<T> =
  | Readonly<{ kind: 'success'; value: T; unavailableIds?: readonly string[] }>
  | Readonly<{ kind: 'empty'; id: string; reason: 'null_payload' }>
  | Failure;

export type CreateIncidentInput = Readonly<{
  category: IncidentCategory;
  description: string;
  location: string;
  idempotencyKey: string;
}>;

export type ClientOptions = Readonly<{
  baseUrl: string;
  actorId: string;
  accessToken: string;
  timeoutMs?: number;
  scenario?: 'success' | 'nullable' | 'malformed' | 'server_error' | 'slow';
  fetchImpl?: typeof fetch;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function decodeIncident(input: unknown): ClientResult<Incident> {
  const parsed = parseRemoteResource(input);
  if (!parsed.ok) return { kind: 'error', code: 'invalid_contract' };
  const { id, version, status, payload } = parsed.value;
  if (!statuses.includes(status as IncidentStatus)) {
    return { kind: 'error', code: 'invalid_contract' };
  }
  if (payload === null) return { kind: 'empty', id, reason: 'null_payload' };
  if (!categories.includes(payload.category as IncidentCategory)
    || !nonempty(payload.description)
    || !nonempty(payload.location)
    || !nonempty(payload.reporterId)
    || !(payload.assignedTechnicianId === null || nonempty(payload.assignedTechnicianId))) {
    return { kind: 'error', code: 'invalid_contract' };
  }
  return { kind: 'success', value: {
    id,
    version,
    title: payload.description,
    description: payload.description,
    category: payload.category as IncidentCategory,
    location: { source: 'manual', label: payload.location },
    work: {
      status: status as IncidentStatus,
      assignedTechnicianId: payload.assignedTechnicianId as string | null,
    },
  } };
}

export class HttpIncidentClient {
  constructor(private readonly options: ClientOptions) {}

  private async request(path: string, init: Readonly<{
    method?: 'POST';
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }> = {}): Promise<ClientResult<unknown>> {
    const timeoutMs = this.options.timeoutMs ?? 1000;
    if (!nonempty(this.options.baseUrl) || !nonempty(this.options.actorId)
      || !nonempty(this.options.accessToken) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { kind: 'error', code: 'invalid_request' };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('request_timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async (): Promise<ClientResult<unknown>> => {
        const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'X-Course-Actor': this.options.actorId,
            ...(this.options.scenario ? { 'X-Course-Scenario': this.options.scenario } : {}),
            ...init.headers,
          },
        });
        if (!response.ok) {
          return { kind: 'error', code: response.status >= 500 ? 'server' : 'http', status: response.status };
        }
        try {
          return { kind: 'success', value: await response.json() as unknown };
        } catch {
          return { kind: 'error', code: controller.signal.aborted ? 'timeout' : 'invalid_contract' };
        }
      })()]);
    } catch (error) {
      return { kind: 'error', code: controller.signal.aborted ||
        (error instanceof Error && error.message === 'request_timeout') ? 'timeout' : 'network' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async list(): Promise<ClientResult<readonly Incident[]>> {
    const response = await this.request('/v1/incidents');
    if (response.kind !== 'success') return response;
    if (!record(response.value) || !Array.isArray(response.value.items)) {
      return { kind: 'error', code: 'invalid_contract' };
    }
    const incidents: Incident[] = [];
    const unavailableIds: string[] = [];
    for (const item of response.value.items) {
      const decoded = decodeIncident(item);
      if (decoded.kind === 'error') return decoded;
      if (decoded.kind === 'empty') unavailableIds.push(decoded.id);
      else incidents.push(decoded.value);
    }
    return { kind: 'success', value: incidents, unavailableIds };
  }

  async detail(id: string): Promise<ClientResult<Incident>> {
    if (!nonempty(id)) return { kind: 'error', code: 'invalid_request' };
    const response = await this.request(`/v1/incidents/${encodeURIComponent(id)}`);
    return response.kind === 'success' ? decodeIncident(response.value) : response;
  }

  async create(input: CreateIncidentInput): Promise<ClientResult<Readonly<{
    incident: Incident;
    operationId: string;
    duplicate: boolean;
  }>>> {
    if (!categories.includes(input.category) || !nonempty(input.description)
      || !nonempty(input.location) || !nonempty(input.idempotencyKey)
      || input.idempotencyKey.length < 8) {
      return { kind: 'error', code: 'invalid_request' };
    }
    const response = await this.request('/v1/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        category: input.category,
        description: input.description,
        location: input.location,
      }),
    });
    if (response.kind !== 'success') return response;
    if (!record(response.value) || response.value.operationId !== input.idempotencyKey
      || typeof response.value.duplicate !== 'boolean') {
      return { kind: 'error', code: 'invalid_contract' };
    }
    const incident = decodeIncident(response.value.incident);
    if (incident.kind !== 'success') return incident;
    return { kind: 'success', value: {
      incident: incident.value,
      operationId: input.idempotencyKey,
      duplicate: response.value.duplicate,
    } };
  }
}
