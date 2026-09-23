import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('T4: el secret scan detecta una credencial ficticia', () => {
  const directory = mkdtempSync(join(tmpdir(), 'campusops-secret-'));
  const file = join(directory, 'fixture.txt');
  writeFileSync(file, 'EXAMPLE_KEY=sk_test_FAKE12345678');

  try {
    expect(() => execFileSync(process.execPath, ['tools/secret-scan.mjs', file], { encoding: 'utf8' }))
      .toThrow(/Secret patterns detected/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
