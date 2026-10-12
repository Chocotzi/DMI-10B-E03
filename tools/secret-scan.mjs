import { readFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node tools/secret-scan.mjs <file>');
  process.exit(2);
}

const source = readFileSync(target, 'utf8');
const patterns = [
  [/sk_test_[A-Za-z0-9]{8,}/, 'test API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
];
const matches = patterns.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);

if (matches.length > 0) {
  console.error(`Secret patterns detected: ${matches.join(', ')}`);
  process.exit(1);
}
console.log('Secret scan passed: no declared patterns detected.');
