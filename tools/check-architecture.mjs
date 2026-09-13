import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(process.cwd(), 'src', 'campusops');
const layers = ['ui', 'application', 'domain', 'infrastructure'];
const forbidden = {
  ui: ['infrastructure'],
  application: ['ui', 'infrastructure'],
  domain: ['ui', 'application', 'infrastructure'],
  infrastructure: ['ui', 'application'],
};

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function layerFor(path) {
  const match = relative(root, path).split(/[\\/]/)[0];
  return layers.includes(match) ? match : null;
}

const violations = [];
for (const file of filesIn(root)) {
  const source = readFileSync(file, 'utf8');
  const fromLayer = layerFor(file);
  if (!fromLayer) continue;
  const importPattern = /(?:import|export)\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(['"]([^'"]+)['"]\)/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    const targetLayer = layers.find((layer) => specifier.includes(`/${layer}/`));
    if (targetLayer && forbidden[fromLayer].includes(targetLayer)) {
      violations.push(`${relative(process.cwd(), file)}: ${fromLayer} -> ${targetLayer} (${specifier})`);
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture violations detected:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries pass: no forbidden layer imports found.');
}
