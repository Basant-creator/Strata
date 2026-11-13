import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';
import { GitClient } from '../src/git/git.js';

/**
 * A target's history through its renames.
 *
 * Read by its current path alone, a file's history stopped at the commit that moved it
 * there, and the oldest commit left, the move, was labelled as the one that introduced the
 * file. The fixture creates a file, changes it for a stated reason, moves it, and keeps
 * working on it under the new path.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-renames-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
const sha: Record<string, string> = {};
let svc: StrataService;

let clock = Date.parse('2026-01-01T00:00:00Z') / 1000;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const dated = (...args: string[]): string => {
  const at = `${clock += 3600} +0000`;
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
};
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};
const commit = (tag: string, message: string): void => {
  git('add', '-A');
  dated('commit', '-q', '-m', message);
  sha[tag] = git('rev-parse', 'HEAD').trim();
};
const short = (tag: string): string => sha[tag]!.slice(0, 7);

const OLD = 'src/limits.ts';
const NOW = 'src/billing/limits.ts';
const body = (extra: string): string => [
  'export function retryLimit(attempts: number): number {',
  '  return Math.min(attempts, 3);',
  '}',
  '',
  'export function backoffMilliseconds(attempt: number): number {',
  '  return 250 * 2 ** attempt;',
  '}',
  '',
  'export function shouldGiveUp(attempt: number, elapsedMs: number): boolean {',
  '  return attempt >= 3 || elapsedMs > 30_000;',
  '}',
  extra,
].join('\n');

beforeAll(() => {
  const globalConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(globalConfig, '', 'utf-8');
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.autocrlf', 'false');

  write(OLD, body(''));
  commit('created', 'Add retry limits');
  write(OLD, body('export const RETRY_JITTER_MS = 40; // spread retries so clients do not stampede\n'));
  commit('change', 'Add jitter to retries\n\nClients retried in lockstep after an outage and took the service down again.');
  fs.mkdirSync(path.dirname(path.join(repo, NOW)), { recursive: true });
  git('mv', OLD, NOW);
  commit('moved', 'Move limits into billing');
  for (let i = 1; i <= 3; i++) {
    write(`src/other${i}.ts`, `export const other${i} = ${i};\n`);
    commit(`noise${i}`, `Unrelated work ${i}`);
  }
  write(NOW, body('export const RETRY_JITTER_MS = 40; // spread retries so clients do not stampede\nexport const MAX_RETRY_BUDGET = 9;\n'));
  commit('later', 'Cap the retry budget');

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

describe('GitClient.getTargetHistory', () => {
  it('reads the file\'s commits from before the move, with the path it had then', () => {
    const { commits, pathThen } = new GitClient(repo).getTargetHistory([NOW], 10);
    expect(commits.map((c) => c.hash)).toEqual([sha['later'], sha['moved'], sha['change'], sha['created']]);
    expect(pathThen.get(sha['change']!)?.get(NOW)).toBe(OLD);
    expect(pathThen.get(sha['created']!)?.get(NOW)).toBe(OLD);
    // The move wrote the new path, and later commits use it: nothing to translate.
    expect(pathThen.has(sha['moved']!)).toBe(false);
    expect(pathThen.has(sha['later']!)).toBe(false);
  });

  it('keeps the oldest commit beyond the limit, so the start of the story is there', () => {
    const { commits } = new GitClient(repo).getTargetHistory([NOW], 1);
    expect(commits.map((c) => c.hash)).toEqual([sha['later'], sha['created']]);
  });
});

describe('a pack about the moved file', () => {
  const ask = () => svc.getContextPack(`Why does ${NOW} add jitter to retries?`);

  it('shows the change made under the old path', () => {
    expect(ask().historicalContext.map((h) => h.shortHash)).toContain(short('change'));
  });

  it('labels the commit that created the file as its origin, not the move', () => {
    const history = ask().historicalContext;
    expect(history.find((h) => h.shortHash === short('created'))?.introducedAnchor).toBe(true);
    expect(history.find((h) => h.shortHash === short('moved'))?.introducedAnchor).not.toBe(true);
  });

  it('reads the decision from the change under the old path, measured against the file now', () => {
    const decision = ask().historicalDecisions.find((d) => d.commit === short('change'));
    expect(decision?.path).toBe(NOW);
    expect(decision?.currentState.join('\n')).toContain('RETRY_JITTER_MS');
    expect(decision?.status).toBe('ACTIVE');
  });
});
