import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { splitClauses } from '../src/code/graph.js';

/**
 * Resolving a pasted bug report.
 *
 * A report's ordinary words ("format", "main", "dependencies", "Input") each spelled some
 * file or exported symbol and ended the search; its commas cut it into a dozen clauses
 * resolved on two words each; "Next.js" in prose read as a missing file and aborted it; and
 * the word ranking rewarded a file for having hundreds of declarations rather than for
 * matching the report's rare words. The fixture reproduces each of those in miniature.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-report-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
let svc: StrataService;

const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};

const FIX = 'src/client/dehydratedBoundary.ts';
const DECOYS = ['src/format.ts', 'src/cli/main.ts', 'fixtures/dependencies.js', 'src/input.ts'];

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'core.autocrlf', 'false']);

  // Ordinary words that are also a file's name or an exported symbol.
  write('src/format.ts', 'export function format(text: string): string {\n  return text.trim();\n}\n');
  write('src/cli/main.ts', 'export function main(): void {}\n');
  write('fixtures/dependencies.js', 'export const fixture = 1;\n');
  write('src/input.ts', "export const input = '';\n");
  // Volume: one file declaring many names that contain the report's common words.
  const many: string[] = [];
  for (let i = 0; i < 40; i++) {
    many.push(`export const hiddenStyle${i} = 'display: none';`);
    many.push(`export const contentRender${i} = 'children';`);
  }
  write('src/dom/environment.ts', many.join('\n') + '\n');
  // The file the report is about: few names, but the report's rare words.
  write(FIX, [
    "export const ACTIVITY_START = '<!--&-->';",
    'export function hideOrUnhideDehydratedBoundary(boundary: { nextSibling: unknown }, hide: boolean): void {',
    '  let sibling = boundary.nextSibling;',
    '  while (sibling && hide) sibling = null;',
    '}',
    'export function dehydratedActivitySibling(boundary: { nextSibling: unknown }): unknown {',
    '  return boundary.nextSibling;',
    '}',
    '',
  ].join('\n'));
  write('src/thenable.ts', 'export function trackUsedThenable(thenable: unknown): unknown {\n  return thenable;\n}\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Fixture']);

  svc = new StrataService(repo);
  svc.init();
  svc.indexCode();
}, 120_000);

afterAll(() => {
  svc?.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(base, { recursive: true, force: true });
});

const REPORT = [
  'Title: Hiding a dehydrated Activity hides every sibling after it',
  '',
  'React version: 19.3.0 (also reproduces on `main`).',
  '',
  'Steps: server-render an Activity, keep it dehydrated, then hide it. Do not install dependencies, do not run the build, and do not run the tests.',
  '',
  'Current behavior: the sibling gets display none, and it stays hidden after the Activity is shown again. The format of the output, the input and the content look fine.',
  '',
  'Expected behavior: only the dehydrated Activity content is hidden. In Next.js with Cache Components, this hides everything a layout renders after children.',
].join('\n');

const target = (query: string) => svc.getContextPack(query).target;

describe('a pasted bug report', () => {
  it('is long enough to be a report, not a coordinated instruction', () => {
    expect(splitClauses(REPORT).length).toBeGreaterThan(5);
  });

  it('lands on the file its rare words single out, first', () => {
    expect(target(REPORT).files[0]).toBe(FIX);
  });

  it('does not anchor on ordinary words that spell a file, a symbol or a package', () => {
    const files = target(REPORT).files;
    for (const decoy of DECOYS) expect(files).not.toContain(decoy);
  });

  it('is not outranked by a file that merely declares many names with its common words', () => {
    const files = target(REPORT).files;
    const fix = files.indexOf(FIX);
    const volume = files.indexOf('src/dom/environment.ts');
    expect(fix).toBe(0);
    expect(volume === -1 || volume > fix).toBe(true);
  });

  it('is not discarded because it mentions a product that looks like a file', () => {
    const t = target(REPORT);
    expect(t.resolution).not.toBe('target_not_found');
    expect(t.files.length).toBeGreaterThan(0);
  });

  it('still anchors a code-shaped name it quotes, as explicitly as before', () => {
    const t = target(REPORT + '\n\nThe stack trace points into `trackUsedThenable`.');
    expect(t.files).toContain('src/thenable.ts');
    expect(t.confidence.level).toBe('HIGH');
  });
});

describe('a short request is unchanged', () => {
  it('a plain word that is exactly an exported symbol still anchors', () => {
    expect(target('where is format defined').files).toContain('src/format.ts');
  });

  it('a filename stem still anchors', () => {
    expect(target('what is in dependencies').files).toContain('fixtures/dependencies.js');
  });
});
