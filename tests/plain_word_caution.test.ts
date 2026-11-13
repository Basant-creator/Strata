import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { StrataService } from '../src/records/service.js';

/**
 * The CAUTION on a live decision, for a task that names a plain English word.
 *
 * On Strata's own repository the pack said a task "names record, which ee77449 moved away
 * from in src/records/service.ts and which is still absent at HEAD" — about a file that
 * uses `record` on every other line. A local variable on a rewritten line was enough. A
 * plain word now collides only when the file has stopped using it; a code-shaped or
 * backticked name keeps its old behaviour (tests/context_pack_v2.test.ts, 15).
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-plainword-'));
const repo = path.join(base, 'repo');
const saved = { ...process.env };
let svc: StrataService;

const git = (args: string[], date?: string): string => execFileSync('git', args, {
  cwd: repo, encoding: 'utf-8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
});
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf-8');
};

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
  write('src/store.ts', [
    'export function save(record: string, email: string): string {',
    '  const owner = email.toLowerCase();',
    '  return `${owner}:${record}`;',
    '}',
    '',
  ].join('\n'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Save records under their owner'], '2026-01-01T10:00:00Z');
  // The decision: saves are keyed on the record id, no longer on the owner's email.
  // `record` is still used throughout the file; `email` and `owner` are gone from it.
  write('src/store.ts', [
    'export function save(record: string, recordId: string): string {',
    '  return `${recordId}:${record}`;',
    '}',
    '',
  ].join('\n'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Key saves on the record id'], '2026-01-02T10:00:00Z');
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

const decision = (query: string) => {
  const d = svc.getContextPack(query, { depth: 1 }).historicalDecisions
    .find((x) => x.path === 'src/store.ts' && x.commitSubject === 'Key saves on the record id');
  expect(d, `the decision is in the pack for "${query}"`).toBeTruthy();
  expect(d!.status).toBe('ACTIVE');
  return d!;
};

describe('a plain word in the task', () => {
  it('is no collision while the file still uses it', () => {
    expect(decision('why does src/store.ts save the record this way').caution).toBeUndefined();
  });

  it('is a collision once the file has stopped using it, and the caution says so truly', () => {
    const d = decision('save records by email again in src/store.ts');
    expect(d.caution?.statement).toMatch(/^This task names email, which [0-9a-f]{7} moved away from in src\/store\.ts and which is still absent at HEAD/);
    expect(d.caution?.provenance).toBe('INFERRED');
  });

  it('names only the words that collide, not the ones still in use', () => {
    const d = decision('group each record by owner in src/store.ts');
    expect(d.caution?.statement).toMatch(/^This task names owner, which/);
    expect(d.caution?.statement).not.toMatch(/names [^.]*record/);
  });
});

describe('a name the task marks as code', () => {
  it('backticked, it collides as before even though the file still uses it', () => {
    expect(decision('why does src/store.ts take `record` first').caution?.statement)
      .toMatch(/^This task names record, which/);
  });
});

describe('a task that names nothing the decision removed', () => {
  it('raises nothing', () => {
    expect(decision('src/store.ts').caution).toBeUndefined();
  });
});
