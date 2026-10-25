// Week 08 — runs the migration/rollback and synchronization suites and keeps the
// observed states (before / after the failure / after recovery) as JSON files.
// Usage: npm run trace:week-08  (works the same on Windows, macOS and Linux).
// Output: reports/week-08/generated-*-trace.json, ignored by Git
// (`reports/**/generated-*`); reports/week-08/migration-tests.json indexes them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const jest = require.resolve('jest/bin/jest');
const traceDir = join(process.cwd(), 'reports', 'week-08');
mkdirSync(traceDir, { recursive: true });

const suites = [
  'course-tests/week-08-migration.test.ts',
  'course-tests/week-08-sync-integration.test.ts',
];
const result = spawnSync(
  process.execPath,
  [jest, '--no-watchman', '--cacheDirectory', '.jest-cache', '--ci', '--runInBand', ...suites],
  { stdio: 'inherit', env: { ...process.env, WEEK08_TRACE_DIR: traceDir } },
);

if (result.status !== 0) {
  console.error('Las pruebas fallaron: las trazas no son evidencia válida.');
  process.exit(result.status ?? 1);
}

for (const name of ['generated-migration-trace.json', 'generated-sync-trace.json']) {
  const file = join(traceDir, name);
  const trace = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`${file}: ${Object.keys(trace.cases).length} casos (${Object.keys(trace.cases).join(', ')})`);
}
