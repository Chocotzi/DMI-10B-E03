/** @jest-environment node */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';
import { HttpIncidentClient } from '../src/campusops/infrastructure/HttpIncidentClient';

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

function client(scenario: 'success' | 'nullable' | 'malformed' | 'server_error' | 'slow', timeoutMs = 1000) {
  return new HttpIncidentClient({
    baseUrl, actorId: 'reporter-1', accessToken: 'course-valid-token',
    scenario, timeoutMs, fetchImpl: localFetch,
  });
}

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
      resolve({ ok: status >= 200 && status < 300, status,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) } as Response);
    });
    reply.on('error', reject);
  });
  connection.on('error', reject);
  connection.end(init?.body as string | undefined);
})) as typeof fetch;

test('controlled backend variants and idempotent creation work without public Internet', async () => {
  const success = await client('success').list();
  expect(success).toEqual(expect.objectContaining({ kind: 'success' }));
  if (success.kind === 'success') expect(success.value[0]?.id).toBe('campus-inc-001');

  expect(await client('nullable').detail('campus-inc-001'))
    .toEqual({ kind: 'empty', id: 'campus-inc-001', reason: 'null_payload' });
  expect(await client('malformed').list()).toEqual({ kind: 'error', code: 'invalid_contract' });
  expect(await client('slow', 50).list()).toEqual({ kind: 'error', code: 'timeout' });
  expect(await client('server_error').list()).toEqual({ kind: 'error', code: 'server', status: 500 });

  const input = { category: 'water' as const, description: 'Fuga simulada', location: 'Zona ficticia', idempotencyKey: 'week05-create-001' };
  const created = await client('success').create(input);
  const replayed = await client('success').create(input);
  expect(created.kind).toBe('success');
  expect(replayed.kind).toBe('success');
  if (created.kind === 'success' && replayed.kind === 'success') {
    expect(created.value.incident.id).toBe(replayed.value.incident.id);
    expect(replayed.value.duplicate).toBe(true);
  }
}, 10000);
