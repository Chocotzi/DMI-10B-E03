/** @jest-environment node */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';

let backend: ChildProcessWithoutNullStreams;
let baseUrl = '';

beforeAll(async () => {
  backend = spawn(process.execPath, ['course-backend/server.mjs'], { cwd: process.cwd(), env: { ...process.env, COURSE_BACKEND_HOST: '127.0.0.1', COURSE_BACKEND_PORT: '0' } });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend startup timeout')), 5000);
    backend.stdout.once('data', chunk => { clearTimeout(timer); const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(`http://127.0.0.1:${match[1]}`); else reject(new Error('invalid backend address')); });
    backend.once('error', reject);
  });
}, 10000);
afterAll(() => backend?.kill());

async function call(actorId: string, path: string, init: RequestInit = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${baseUrl}${path}`);
    const req = request(target, { method: init.method ?? 'GET', headers: { Authorization: 'Bearer course-valid-token', 'X-Course-Actor': actorId, ...(init.headers as Record<string, string> ?? {}) } }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end(init.body as string | undefined);
  });
}

test('login and server-side RBAC reject unauthorized profiles', async () => {
  const login = await call('reporter-1', '/v1/session/login', { method: 'POST', body: JSON.stringify({ actorId: 'reporter-1' }) });
  expect(login.status).toBe(200);
  expect((await call('reporter-2', '/v1/incidents/campus-inc-001')).status).toBe(403);
  expect((await call('technician-2', '/v1/incidents/campus-inc-001')).status).toBe(403);
  expect((await call('coordinator-1', '/v1/incidents/campus-inc-001')).status).toBe(200);
});

test('server enforces coordinator and technician actions', async () => {
  const forbidden = await call('reporter-1', '/v1/incidents/campus-inc-001/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'auth-test-001' }, body: JSON.stringify({ action: 'close', baseVersion: 1 }) });
  expect(forbidden.status).toBe(403);
  const technician = await call('technician-1', '/v1/incidents/campus-inc-001/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'auth-test-002' }, body: JSON.stringify({ action: 'start', baseVersion: 1 }) });
  expect(technician.status).toBe(201);
});
