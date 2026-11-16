import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const LCOV = resolve(ROOT, 'coverage/lcov.info');
const PROCESS_ENTRYPOINTS = new Set(['src/main.ts']);
const DOMAIN_MIN = 0.95;
const OVERALL_MIN = 0.9;
const FILE_MIN = 0.8;

interface FileCoverage {
  found: number;
  hit: number;
}

const RUNTIME_EXPORT = /^export (?:const|let|function|async function|class|abstract class|enum)\b/m;

function hasRuntimeCode(path: string): boolean {
  return RUNTIME_EXPORT.test(readFileSync(path, 'utf8'));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return path.endsWith('.ts') && hasRuntimeCode(path) ? [relative(ROOT, path)] : [];
  });
}

function parseLcov(text: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let current: string | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = relative(ROOT, resolve(ROOT, line.slice(3)));
      files.set(current, { found: 0, hit: 0 });
    } else if (current && line.startsWith('LF:')) {
      (files.get(current) as FileCoverage).found = Number.parseInt(line.slice(3), 10);
    } else if (current && line.startsWith('LH:')) {
      (files.get(current) as FileCoverage).hit = Number.parseInt(line.slice(3), 10);
    }
  }

  return files;
}

function ratio(entries: FileCoverage[]): number {
  const found = entries.reduce((sum, e) => sum + e.found, 0);
  const hit = entries.reduce((sum, e) => sum + e.hit, 0);

  return found === 0 ? 1 : hit / found;
}

const report = parseLcov(readFileSync(LCOV, 'utf8'));
const expected = sourceFiles(resolve(ROOT, 'src')).filter((file) => !PROCESS_ENTRYPOINTS.has(file));
const missing = expected.filter((file) => !report.has(file));
const srcEntries = [...report.entries()].filter(([file]) => file.startsWith('src/'));
const domain = srcEntries.filter(
  ([file]) => file.includes('/domain/') || file.startsWith('src/shared/'),
);
const overall = ratio(srcEntries.map(([, c]) => c));
const domainRatio = ratio(domain.map(([, c]) => c));
const failures: string[] = [];

if (missing.length > 0) {
  failures.push(
    `files absent from the coverage report (never imported by a test):\n  ${missing.join('\n  ')}`,
  );
}
if (domainRatio < DOMAIN_MIN) {
  failures.push(
    `domain + shared line coverage ${(domainRatio * 100).toFixed(2)}% < ${DOMAIN_MIN * 100}%`,
  );
}
const weakFiles = srcEntries
  .filter(([, c]) => ratio([c]) < FILE_MIN)
  .map(([file, c]) => `${file} ${(ratio([c]) * 100).toFixed(2)}%`);

if (weakFiles.length > 0) {
  failures.push(`files below ${FILE_MIN * 100}% line coverage:\n  ${weakFiles.join('\n  ')}`);
}
if (overall < OVERALL_MIN) {
  failures.push(`overall src line coverage ${(overall * 100).toFixed(2)}% < ${OVERALL_MIN * 100}%`);
}
console.log(
  `coverage: overall ${(overall * 100).toFixed(2)}%, domain ${(domainRatio * 100).toFixed(2)}%, files ${srcEntries.length}/${expected.length}`,
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
