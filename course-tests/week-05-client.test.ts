import { parseRemoteResource } from '../src/course-evaluation';
import { HttpIncidentClient } from '../src/campusops/infrastructure/HttpIncidentClient';

const dto = {
  id: 'campus-inc-001', version: 1, status: 'assigned',
  payload: {
    category: 'connectivity', description: 'Sin conexión ficticia',
    location: 'Edificio A', reporterId: 'reporter-1',
    assignedTechnicianId: 'technician-1',
  },
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function client(fetchImpl: typeof fetch, scenario?: 'nullable' | 'slow') {
  return new HttpIncidentClient({
    baseUrl: 'http://127.0.0.1:4310', actorId: 'reporter-1',
    accessToken: 'course-valid-token', timeoutMs: 20,
    ...(scenario ? { scenario } : {}), fetchImpl,
  });
}

test('shared parser accepts nullable envelopes and ignores future fields', () => {
  expect(parseRemoteResource({ ...dto, payload: null, future: true })).toEqual({
    ok: true, value: { id: dto.id, version: 1, status: 'assigned', payload: null },
  });
  expect(parseRemoteResource({ ...dto, version: 1.5 }).ok).toBe(false);
  expect(parseRemoteResource({ ...dto, payload: [] }).ok).toBe(false);
});

test('list maps DTO to app model without adding absent server data', async () => {
  const fetchImpl = jest.fn(async () => response({ items: [dto] })) as unknown as typeof fetch;
  const result = await client(fetchImpl).list();
  expect(result).toEqual({ kind: 'success', unavailableIds: [], value: [{
    id: dto.id, version: 1, title: 'Sin conexión ficticia',
    description: 'Sin conexión ficticia', category: 'connectivity',
    location: { source: 'manual', label: 'Edificio A' },
    work: { status: 'assigned', assignedTechnicianId: 'technician-1' },
  }] });
  expect((result.kind === 'success' ? result.value[0] : null)).not.toHaveProperty('createdAt');
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4310/v1/incidents', expect.objectContaining({
    headers: expect.objectContaining({ 'X-Course-Actor': 'reporter-1' }),
  }));
});

test('null payload is empty; malformed domain or envelope is invalid', async () => {
  const nullable = client(jest.fn(async () => response({ ...dto, payload: null })) as unknown as typeof fetch, 'nullable');
  expect(await nullable.detail(dto.id)).toEqual({ kind: 'empty', id: dto.id, reason: 'null_payload' });
  const malformed = client(jest.fn(async () => response({ ...dto, payload: { category: 'water' } })) as unknown as typeof fetch);
  expect(await malformed.detail(dto.id)).toEqual({ kind: 'error', code: 'invalid_contract' });
  const invalidStatus = client(jest.fn(async () => response({ ...dto, status: 'invented', payload: null })) as unknown as typeof fetch);
  expect(await invalidStatus.detail(dto.id)).toEqual({ kind: 'error', code: 'invalid_contract' });
  const invalidJson = client(jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } })) as unknown as typeof fetch);
  expect(await invalidJson.list()).toEqual({ kind: 'error', code: 'invalid_contract' });
});

test('list keeps valid records separate from nullable records', async () => {
  const fetchImpl = jest.fn(async () => response({ items: [dto, { ...dto, id: 'campus-inc-002', payload: null }] })) as unknown as typeof fetch;
  const result = await client(fetchImpl).list();
  expect(result.kind).toBe('success');
  if (result.kind === 'success') {
    expect(result.value).toHaveLength(1);
    expect(result.unavailableIds).toEqual(['campus-inc-002']);
  }
});

test('create sends stable idempotency key and validates response', async () => {
  const fetchImpl = jest.fn(async () => response({ incident: { ...dto, status: 'open', payload: { ...dto.payload, assignedTechnicianId: null } }, operationId: 'create-001', duplicate: false }, 201)) as unknown as typeof fetch;
  const result = await client(fetchImpl).create({ category: 'water', description: 'Fuga ficticia', location: 'Edificio B', idempotencyKey: 'create-001' });
  expect(result.kind).toBe('success');
  expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:4310/v1/incidents', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ category: 'water', description: 'Fuga ficticia', location: 'Edificio B' }),
    headers: expect.objectContaining({ 'Idempotency-Key': 'create-001' }),
  }));
});

test('timeout, server error and network error remain distinct results', async () => {
  const never = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  expect(await client(never, 'slow').list()).toEqual({ kind: 'error', code: 'timeout' });
  expect(await client(jest.fn(async () => response({ code: 'controlled_failure' }, 500)) as unknown as typeof fetch).list())
    .toEqual({ kind: 'error', code: 'server', status: 500 });
  expect(await client(jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch).list())
    .toEqual({ kind: 'error', code: 'network' });
  expect(await client(jest.fn(async () => response({ code: 'rate_limited' }, 429)) as unknown as typeof fetch).list())
    .toEqual({ kind: 'error', code: 'http', status: 429 });
});
