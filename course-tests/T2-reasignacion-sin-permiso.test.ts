import { spawn } from 'node:child_process';
import { request } from 'node:http';

let backend: ReturnType<typeof spawn>;
let baseUrl: string;

beforeAll(async () => {
  backend = spawn(process.execPath, ['course-backend/server.mjs'], {
    env: { ...process.env, COURSE_BACKEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('backend startup timeout')), 5000);
    backend.stdout!.setEncoding('utf8');
    backend.stdout!.on('data', (chunk) => {
      const match = chunk.match(/(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
});

afterAll(() => backend.kill());

test('T2: un reportante no puede reasignar una incidencia', async () => {
  const response = await new Promise<number>((resolve, reject) => {
    const target = new URL(`${baseUrl}/v1/incidents/campus-inc-001/actions`);
    const body = JSON.stringify({ action: 'assign', baseVersion: 1, technicianId: 'technician-2' });
    const req = request(target, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer course-valid-token',
        'X-Course-Actor': 'reporter-1',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Idempotency-Key': 'unauthorized-reassign',
      },
    }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end(body);
  });
  expect(response).toBe(403);
});
